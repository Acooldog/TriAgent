from __future__ import annotations

import re
from typing import Any, Callable


def _build_extra_body(model_config: dict[str, Any]) -> dict[str, Any]:
    """为不同模型提供商构建 provider-specific extra_body 参数（关闭深度思考等）。
    
    注意：extra_body 可能导致某些 API 鉴权失败（如讯飞新版 Spark HTTP API）。
    如果遇到 11200 AppIdNoAuthError，先关掉 thinking 试试。
    """
    extra: dict[str, Any] = {}
    thinking_mode = str(model_config.get("thinking", "enabled") or "enabled").lower()
    # 只在明确要求关闭时才加 extra_body，默认不加（避免干扰鉴权）
    if thinking_mode == "disabled":
        extra["thinking"] = {"type": "disabled"}
    return extra


def _clean_field(raw: str) -> str:
    """清理用户输入里的 Markdown 反引号、两端逗号/空格。"""
    if not raw:
        return raw
    cleaned = raw.strip()
    # 去掉可能的 Markdown 反引号包裹: `value`
    if len(cleaned) >= 2 and cleaned[0] == "`" and cleaned[-1] == "`":
        cleaned = cleaned[1:-1]
    # 去掉尾部多余的逗号（用户复制粘贴可能带入）
    cleaned = cleaned.rstrip(",，;；").strip()
    return cleaned


def create_chat_model(model_config: dict[str, Any], initializer: Callable[..., Any]) -> Any:
    model_name = _clean_field(str(model_config.get("model", "glm-4.5")))
    base_url = _clean_field(str(model_config.get("base_url", "https://open.bigmodel.cn/api/paas/v4")))
    api_key = _clean_field(str(model_config.get("api_key", "")))
    temperature = float(model_config.get("temperature", 0.7))
    if not api_key:
        raise RuntimeError("未配置 API Key")

    kwargs: dict[str, Any] = {
        "model": model_name,
        "model_provider": str(model_config.get("provider", "openai")).lower(),
        "base_url": base_url,
        "api_key": api_key,
        "temperature": temperature,
    }
    max_tokens = model_config.get("max_tokens")
    if max_tokens:
        kwargs["max_tokens"] = int(max_tokens)
    # extra_body 透传 provider-specific 参数（如关闭深度思考）
    extra_body = _build_extra_body(model_config)
    print(f"[agent_model] create_chat_model: base_url={base_url}, model={model_name}, extra_body={extra_body}", flush=True)
    if extra_body:
        kwargs["extra_body"] = extra_body
    return initializer(**kwargs)
