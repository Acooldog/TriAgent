"""Universal adapter — 通用工具调用弱模型适配器。

适用于任何模型：当模型输出文本计划（而非调用工具）时，
自动检测计划内容并重新 prompt 模型执行工具调用。

检测策略：
1. 文本包含 markdown 标题 + 步骤编号
2. 文本包含工具相关关键词（扫描/解密/转换/搜索等）
3. 文本长度 >= 50 字符且结构清晰
"""
from __future__ import annotations

import re
from typing import Any

from src.Infrastructure.adapters.agent.model_adapters.base_adapter import (
    ModelAdapter,
    ModelAdapterContext,
)

# 计划检测：markdown 标题 + 步骤
_PLAN_PATTERNS: list[re.Pattern] = [
    re.compile(r"#{1,3}\s+.+"),           # markdown 标题
    re.compile(r"^\s*\d+[.、)）]\s+", re.MULTILINE),  # 编号步骤
    re.compile(r"[-*]\s+\S+"),              # 无序列表
]

# 工具相关关键词
_TOOL_KEYWORDS: set[str] = {
    "扫描", "解密", "转换", "搜索", "查找", "分析", "识别",
    "提取", "读取", "写入", "处理", "执行", "调用", "运行",
    "scan", "decrypt", "convert", "search", "find", "analyze",
    "extract", "read", "write", "process", "execute", "call",
}

# 典型"计划"关键词
_PLAN_SIGNALS: set[str] = {
    "步骤", "操作", "方法", "流程", "计划", "方案",
    "step", "plan", "method", "procedure", "how to",
}


class UniversalAdapter(ModelAdapter):
    """通用适配器 — 通过检测计划文本并重新 prompt 来补救弱工具调用。"""

    def supports(self, model_config: dict[str, Any]) -> bool:
        """通用适配器支持所有模型（作为 fallback）。"""
        return True

    def handle_no_tool_calls(self, ctx: ModelAdapterContext) -> ModelAdapterContext:
        """检测计划文本并生成重新 prompt。"""
        text = ctx.model_output_text.strip()
        if not text or len(text) < 30:
            self._log(ctx, f"文本太短 ({len(text)}ch)，不触发计划补救")
            return ctx

        if not self._detect_plan(text, ctx):
            self._log(ctx, "文本未检测到计划模式，不触发补救")
            return ctx

        self._log(ctx, f"检测到计划文本 ({len(text)}ch)，生成补救 prompt")
        ctx.re_prompt_needed = True
        ctx.re_prompt_message = self._build_re_prompt(text, ctx.user_message)
        return ctx

    def _detect_plan(self, text: str, ctx: ModelAdapterContext | None = None) -> bool:
        """检测文本是否为结构化计划。"""
        score = 0

        # 检查 markdown 结构
        for pattern in _PLAN_PATTERNS:
            matches = pattern.findall(text)
            if matches:
                score += min(len(matches), 3)

        # 检查工具关键词
        text_lower = text.lower()
        keyword_hits = sum(1 for kw in _TOOL_KEYWORDS if kw in text_lower)
        score += min(keyword_hits, 3)

        # 检查计划信号词
        signal_hits = sum(1 for kw in _PLAN_SIGNALS if kw in text_lower)
        score += min(signal_hits, 2)

        # 阈值：>= 4 分判定为计划
        is_plan = score >= 4
        if is_plan and ctx is not None:
            self._log(
                ctx,
                f"计划检测得分={score} (kw={keyword_hits}, signal={signal_hits})",
            )
        return is_plan

    def _build_re_prompt(self, plan_text: str, original_request: str) -> str:
        """构建重新 prompt — 要求模型基于自己的计划调用工具。"""
        # 提取计划中的关键动作/路径信息
        key_info = self._extract_key_info(plan_text)

        parts = [
            "## 🔧 执行阶段",
            "",
            f"你刚才已经分析了用户的请求并生成了执行计划。现在请**直接调用工具**来执行这个计划，",
            "不要再输出新的分析文本。",
            "",
            f"**用户原始请求**：{original_request[:200]}",
            "",
        ]

        if key_info:
            parts.append("**从你的计划中提取的关键信息**：")
            parts.append("```")
            parts.append(key_info)
            parts.append("```")
            parts.append("")

        parts.extend([
            "**执行要求**：",
            "1. 根据上述关键信息，使用可用工具逐步完成任务",
            "2. 每调用一个工具就等待结果，再决定下一步",
            "3. 遇到错误立即报告，不要跳过",
            "4. 完成后输出简要总结",
            "",
            "**现在开始调用工具执行**：",
        ])

        return "\n".join(parts)

    def _extract_key_info(self, text: str) -> str:
        """从计划文本中提取关键信息（路径、参数等）。"""
        lines: list[str] = []

        # 提取路径/目录
        path_pattern = re.compile(r"[A-Za-z]:\\[^\s`'\"，,、]+")
        paths = path_pattern.findall(text)
        if paths:
            lines.append(f"涉及路径: {', '.join(paths[:5])}")

        # 提取格式/参数
        format_pattern = re.compile(r"(?:格式|format|ogg|mp3|flac|wav|m4a)")
        formats = set(format_pattern.findall(text.lower()))
        if formats:
            lines.append(f"涉及格式: {', '.join(formats)}")

        # 提取工具相关动作
        for kw in sorted(_TOOL_KEYWORDS):
            count = len(re.findall(kw, text, re.IGNORECASE))
            if count > 0:
                lines.append(f"  - {kw}: 出现{count}次")

        return "\n".join(lines) if lines else text[:300]


__all__ = ["UniversalAdapter"]
