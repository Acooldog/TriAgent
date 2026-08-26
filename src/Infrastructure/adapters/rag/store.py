"""ChromaDB 嵌入式持久化客户端与集合管理。

持久化目录默认位于应用根目录下的 _rag/，可通过环境变量 TRIMUSIC_RAG_DIR 覆盖。
集合名固定为 "knowledge"，存储 id/text/metadata/source。
"""
from __future__ import annotations

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


def _resolve_persist_dir() -> pathlib.Path:
    custom = os.environ.get("TRIMUSIC_RAG_DIR", "").strip()
    if custom:
        return pathlib.Path(custom)
    return pathlib.Path(__file__).resolve().parents[2] / "_rag"


def _embedding_function():
    class _LocalEmbedding:
        def __call__(self, input: list[str]) -> list[list[float]]:
            return embed_texts(input)

        def name(self) -> str:
            return "trimusic-local-sentence-transformers"

    return _LocalEmbedding()


def _ensure_client() -> Any:
    """获取或初始化 ChromaDB 客户端和集合（线程安全，加锁模式）。"""
    global _client, _collection, _persist_dir
    with _client_lock:
        if _collection is None:
            import chromadb

            _persist_dir = _resolve_persist_dir()
            _persist_dir.mkdir(parents=True, exist_ok=True)
            print(f"[rag.store] ChromaDB 持久化目录: {_persist_dir}")
            _client = chromadb.PersistentClient(path=str(_persist_dir))
            _collection = _client.get_or_create_collection(
                name=COLLECTION_NAME,
                embedding_function=_embedding_function(),
                metadata={"hnsw:space": "cosine"},
            )
    return _collection


def upsert_document(text: str, source: str = "", metadata: dict[str, Any] | None = None) -> str:
    """写入或更新一条知识（按内容哈希去重）。返回记录 id。"""
    collection = _ensure_client()
    doc_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{source}:{text}"))
    meta = {"source": source or "unknown", **(metadata or {})}
    collection.upsert(ids=[doc_id], documents=[text], metadatas=[meta])
    print(f"[rag.store] upsert id={doc_id} source={source} len={len(text)}")
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
