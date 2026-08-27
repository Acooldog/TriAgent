from __future__ import annotations

import re
from typing import Any, Callable


def _detect_provider(base_url: str) -> str:
    """根据 base_url 检测 provider 类型。"""
    bl = base_url.lower()
    if "tencentmaas.com" in bl or "hunyuan" in bl or "yuanbao" in bl:
        return "tencent_maas"
    if "localhost" in bl or "127.0.0.1" in bl:
        return "local"
    return "standard"


def _build_extra_body(model_config: dict[str, Any], provider: str = "standard") -> dict[str, Any]:
    """为不同模型提供商构建 provider-specific extra_body 参数。

    元宝(Tencent Maas)等 provider 可能不支持 thinking 参数，
    因此对这些 provider 跳过 extra_body 透传。
    """
    extra: dict[str, Any] = {}
    # 元宝等 provider: 跳过 extra_body（可能不支持 thinking 字段导致 400）
    if provider == "tencent_maas":
        return extra
    thinking_mode = str(model_config.get("thinking", "enabled") or "enabled").lower()
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

    # === Provider 检测 ===
    provider = _detect_provider(base_url)
    print(f"[agent_model] 检测到 provider={provider} (base_url={base_url})", flush=True)

    # === 本地端点: Ollama/LM Studio 等不需要 api_key ===
    _is_local = provider == "local"
    if not api_key and _is_local:
        api_key = "ollama"
        print(f"[agent_model] 本地端点，api_key 空 → 自动填 '{api_key}'", flush=True)
    if not api_key:
        raise RuntimeError("未配置 API Key")

    kwargs: dict[str, Any] = {
        "model": model_name,
        "model_provider": str(model_config.get("provider", "openai")).lower(),
        "base_url": base_url,
        "api_key": api_key,
        "temperature": temperature,
    }

    # === 本地端点绕过系统代理 ===
    if _is_local:
        try:
            import httpx
            kwargs["http_client"] = httpx.Client(trust_env=False)
            print(f"[agent_model] localhost 端点，绕过系统代理 (trust_env=False)", flush=True)
        except ImportError:
            pass

    # === 元宝适配: 显式 httpx 超时，避免无限等待 ===
    if provider == "tencent_maas":
        try:
            import httpx
            kwargs["http_client"] = httpx.Client(
                timeout=httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=30.0),
            )
            print(f"[agent_model] 元宝端点，设置 httpx 超时 (connect=15s, read=120s)", flush=True)
        except ImportError:
            print(f"[agent_model] httpx 不可用，跳过超时设置", flush=True)

    max_tokens = model_config.get("max_tokens")
    if max_tokens:
        kwargs["max_tokens"] = int(max_tokens)
    # extra_body: 元宝自动跳过，其他 provider 按 thinking 配置生成
    extra_body = _build_extra_body(model_config, provider=provider)
    print(f"[agent_model] create_chat_model: base_url={base_url}, model={model_name}, provider={provider}, extra_body={extra_body}", flush=True)
    if extra_body:
        kwargs["extra_body"] = extra_body
    return initializer(**kwargs)
