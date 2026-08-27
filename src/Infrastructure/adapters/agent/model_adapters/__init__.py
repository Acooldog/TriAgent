"""Agent model adapters — 模型特定适配层。

当模型工具调用能力弱、输出计划而非调用工具时，通过适配层进行补救。
遵循 SOLID：每个适配器单一职责，通过 ModelAdapter 接口统一调用。
"""
from __future__ import annotations

from src.Infrastructure.adapters.agent.model_adapters.base_adapter import (
    ModelAdapter,
    ModelAdapterContext,
)
from src.Infrastructure.adapters.agent.model_adapters.universal_adapter import (
    UniversalAdapter,
)
from src.Infrastructure.adapters.agent.model_adapters.yuanbao_adapter import (
    YuanbaoAdapter,
    detect_provider,
)

__all__ = [
    "ModelAdapter",
    "ModelAdapterContext",
    "UniversalAdapter",
    "YuanbaoAdapter",
    "detect_provider",
    "select_adapter",
]


def select_adapter(model_config: dict) -> ModelAdapter:
    """根据 model_config 自动选择最合适的适配器。

    优先级：特定模型适配器 > 通用适配器。
    """
    adapters: list[ModelAdapter] = [
        YuanbaoAdapter(),
        UniversalAdapter(),
    ]
    for adapter in adapters:
        if adapter.supports(model_config):
            return adapter
    return UniversalAdapter()
