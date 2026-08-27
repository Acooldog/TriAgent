"""本地 sentence-transformers 向量化（离线优先，首次自动下载后缓存）。

模型默认 BAAI/bge-small-zh-v1.5（中文友好、体积小）。
可通过环境变量 TRIMUSIC_RAG_MODEL_PATH 指定已随包附带的本地模型目录，避免首次联网下载。
"""
from __future__ import annotations

import os
import threading
from typing import Any

DEFAULT_MODEL_NAME = "BAAI/bge-small-zh-v1.5"

_model_lock = threading.Lock()
_model: Any | None = None
_model_name_resolved: str | None = None


def _resolve_model_source() -> str:
    custom = os.environ.get("TRIMUSIC_RAG_MODEL_PATH", "").strip()
    return custom or DEFAULT_MODEL_NAME


def _load_model() -> Any:
    from sentence_transformers import SentenceTransformer

    source = _resolve_model_source()
    print(f"[rag.embedding] 加载 sentence-transformers 模型: {source}")
    return SentenceTransformer(source)


def get_embedding_model() -> Any:
    global _model, _model_name_resolved
    if _model is not None and _model_name_resolved == _resolve_model_source():
        return _model
    with _model_lock:
        if _model is None or _model_name_resolved != _resolve_model_source():
            _model = _load_model()
            _model_name_resolved = _resolve_model_source()
    return _model


def embed_texts(texts: list[str]) -> list[list[float]]:
    """把文本批量转向量。"""
    if not texts:
        return []
    model = get_embedding_model()
    vectors = model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
    return [list(map(float, vec)) for vec in vectors]


def embed_query(text: str) -> list[float]:
    return embed_texts([text])[0]
