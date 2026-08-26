from __future__ import annotations

from typing import Any, Callable


def _build_extra_body(model_config: dict[str, Any]) -> dict[str, Any]:
    """为不同模型提供商构建 provider-specific extra_body 参数（关闭深度思考等）。"""
    extra: dict[str, Any] = {}
    thinking_mode = str(model_config.get("thinking", "disabled") or "disabled").lower()
    if thinking_mode != "enabled":
        thinking_obj = {"type": thinking_mode}  # disabled / auto
        extra["thinking"] = thinking_obj
    return extra


def create_chat_model(model_config: dict[str, Any], initializer: Callable[..., Any]) -> Any:
    model_name = str(model_config.get("model", "glm-4.5"))
    base_url = str(model_config.get("base_url", "https://open.bigmodel.cn/api/paas/v4"))
    api_key = str(model_config.get("api_key", ""))
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
    if extra_body:
        kwargs["extra_body"] = extra_body
    return initializer(**kwargs)
