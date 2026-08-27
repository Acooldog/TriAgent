"""ChromaDB 嵌入式持久化客户端与集合管理。

持久化目录默认位于应用根目录下的 _rag/，可通过环境变量 TRIMUSIC_RAG_DIR 覆盖。
集合名固定为 "knowledge"，存储 id/text/metadata/source。

当 chromadb 不可用时，自动降级为基于 JSON 文件的轻量存储（关键词匹配），
保证 RAG 功能始终可用。
"""
from __future__ import annotations

import json
import os
import pathlib
import threading
import uuid
from typing import Any

from src.Infrastructure.adapters.rag.embedding import embed_texts

COLLECTION_NAME = "knowledge"

_client_lock = threading.Lock()
_client: Any | None = None
_collection: Any | None = None
_persist_dir: pathlib.Path | None = None
_use_chroma: bool = False  # 运行时探测 chromadb 是否可用


def _resolve_persist_dir() -> pathlib.Path:
    custom = os.environ.get("TRIMUSIC_RAG_DIR", "").strip()
    if custom:
        return pathlib.Path(custom)
    # 默认存到项目根目录下的 _rag/，避免污染源码目录
    return pathlib.Path(__file__).resolve().parents[4] / "_rag"


def _embedding_function():
    class _LocalEmbedding:
        def embed_documents(self, input: list[str]) -> list[list[float]]:
            return embed_texts(input)

        def embed_query(self, input: Any) -> list[list[float]]:
            # chromadb 1.x 要求返回 list[list[float]]（即使只有一个查询）
            texts = input if isinstance(input, list) else [str(input)]
            return embed_texts(texts)

        def __call__(self, input: list[str]) -> list[list[float]]:
            return embed_texts(input)

        def name(self) -> str:
            return "trimusic-local-sentence-transformers"

    return _LocalEmbedding()


def _ensure_client() -> Any:
    """获取或初始化集合（线程安全，加锁模式）。

    优先使用 ChromaDB；不可用时降级为 JSON 存储。
    """
    global _client, _collection, _persist_dir, _use_chroma
    with _client_lock:
        if _collection is not None:
            return _collection
        _persist_dir = _resolve_persist_dir()
        _persist_dir.mkdir(parents=True, exist_ok=True)
        try:
            import chromadb  # noqa: F811

            _client = chromadb.PersistentClient(path=str(_persist_dir))
            _collection = _client.get_or_create_collection(
                name=COLLECTION_NAME,
                embedding_function=_embedding_function(),
                metadata={"hnsw:space": "cosine"},
            )
            _use_chroma = True
            print(f"[rag.store] ChromaDB 持久化目录: {_persist_dir}")
            return _collection
        except ImportError:
            print("[rag.store] chromadb 不可用，降级为 JSON 轻量存储")
            _use_chroma = False
            _collection = _JsonStore(_persist_dir / "knowledge.json")
            return _collection


class _JsonStore:
    """基于 JSON 文件的极简向量存储降级方案。

    使用关键词重叠度评分（Jaccard + 词频加权）替代向量相似度。
    仅用于 chromadb 不可用时的保底方案。
    """

    def __init__(self, path: pathlib.Path):
        self._path = path
        self._data: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if self._path.exists():
            try:
                self._data = json.loads(self._path.read_text(encoding="utf-8"))
            except Exception:
                self._data = {}

    def _save(self) -> None:
        try:
            self._path.write_text(
                json.dumps(self._data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            print(f"[rag.store] JSON 存储写入失败: {exc}")

    def upsert(self, ids: list[str], documents: list[str], metadatas: list[dict[str, Any]]) -> None:
        for doc_id, text, meta in zip(ids, documents, metadatas):
            self._data[doc_id] = {"text": text, "metadata": meta}
        self._save()

    def query(self, query_texts: list[str], n_results: int = 4) -> dict[str, Any]:
        results: dict[str, Any] = {"documents": [[]], "metadatas": [[]], "distances": [[]]}
        if not self._data:
            return results

        query = query_texts[0].lower() if query_texts else ""
        query_words = set(query.split())

        scored: list[tuple[float, str, dict[str, Any]]] = []
        for doc_id, entry in self._data.items():
            text = entry["text"].lower()
            text_words = set(text.split())
            # Jaccard similarity + substring boost
            intersection = query_words & text_words
            union = query_words | text_words
            jaccard = len(intersection) / len(union) if union else 0.0
            substring_boost = 0.2 if query in text else 0.0
            score = jaccard + substring_boost
            if score > 0:
                scored.append((score, entry["text"], entry.get("metadata", {})))

        scored.sort(key=lambda x: x[0], reverse=True)
        top = scored[:n_results]

        results["documents"] = [[s[1] for s in top]]
        results["metadatas"] = [[s[2] for s in top]]
        # distance = 1 - score (higher score = lower distance)
        results["distances"] = [[1.0 - s[0] for s in top]]
        return results

    def count(self) -> int:
        return len(self._data)


def upsert_document(text: str, source: str = "", metadata: dict[str, Any] | None = None) -> str:
    """写入或更新一条知识（按内容哈希去重）。返回记录 id。"""
    collection = _ensure_client()
    doc_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{source}:{text}"))
    meta = {"source": source or "unknown", **(metadata or {})}
    collection.upsert(ids=[doc_id], documents=[text], metadatas=[meta])
    mode = "chromadb" if _use_chroma else "json"
    print(f"[rag.store:{mode}] upsert id={doc_id} source={source} len={len(text)}")
    return doc_id


def query_similar(text: str, top_k: int = 4) -> list[dict[str, Any]]:
    """检索与 text 最相关的 top_k 条知识。"""
    collection = _ensure_client()
    result = collection.query(query_texts=[text], n_results=max(1, int(top_k)))
    docs = (result.get("documents") or [[]])[0]
    metas = (result.get("metadatas") or [[]])[0]
    dists = (result.get("distances") or [[]])[0]
    out: list[dict[str, Any]] = []
    for i, doc in enumerate(docs):
        out.append({
            "text": doc,
            "source": (metas[i].get("source") if i < len(metas) and metas[i] else "") or "",
            "score": 1.0 - float(dists[i]) if i < len(dists) else 0.0,
        })
    return out


def count_documents() -> int:
    collection = _ensure_client()
    try:
        return int(collection.count())
    except Exception:
        return 0