"""Model adapter base — 模型适配器抽象基类与上下文。

所有模型适配器必须继承 ModelAdapter 并实现 supports() / handle_no_tool_calls()。
通过 ModelAdapterContext 在适配器与执行器之间传递状态。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class ModelAdapterContext:
    """适配器执行上下文 — 封装适配器所需的所有依赖。"""

    # 只读输入
    model_config: dict[str, Any] = field(default_factory=dict)
    user_message: str = ""
    model_output_text: str = ""          # 模型首次输出的文本（可能是计划）
    event_count: int = 0
    actual_iterations: int = 0
    tool_call_count: int = 0

    # 可写输出（适配器修改后反馈给执行器）
    re_prompt_needed: bool = False       # 是否需要用新 prompt 重跑
    re_prompt_message: str = ""         # 重跑时追加的消息
    adapter_logs: list[str] = field(default_factory=list)  # 适配器日志


class ModelAdapter(ABC):
    """模型适配器抽象基类。

    职责：
    1. 判断是否支持某 model_config（supports）
    2. 当模型输出文本但不调用工具时，生成补救策略（handle_no_tool_calls）
    """

    @abstractmethod
    def supports(self, model_config: dict[str, Any]) -> bool:
        """判断此适配器是否支持给定的模型配置。"""

    @abstractmethod
    def handle_no_tool_calls(self, ctx: ModelAdapterContext) -> ModelAdapterContext:
        """处理模型输出文本但不调用工具的情况。

        返回更新后的 ctx（re_prompt_needed=True 时执行器会重跑 stream）。
        """

    def _log(self, ctx: ModelAdapterContext, msg: str) -> None:
        """向上下文追加日志。"""
        ctx.adapter_logs.append(f"[{self.__class__.__name__}] {msg}")


__all__ = [
    "ModelAdapter",
    "ModelAdapterContext",
]
