"""Yuanbao adapter — 腾讯元宝(Tencent Maas)模型适配器。

元宝 hy-mt2-pro 等模型工具调用能力较弱，容易输出文本计划而非调用工具。
此适配器提供：
1. 元宝域名检测（复用自 agent_model.py / agent_config_preflight.py）
2. 元宝特定的重新 prompt 模板
3. 元宝模型的 provider 信息
"""
from __future__ import annotations

from typing import Any

from src.Infrastructure.adapters.agent.model_adapters.base_adapter import (
    ModelAdapter,
    ModelAdapterContext,
)

# 元宝相关域名
_YUANBAO_DOMAINS = ("tencentmaas.com", "hunyuan", "yuanbao")

# 元宝模型名称关键词
_YUANBAO_MODELS = ("hy-", "yuanbao", "hunyuan")


def detect_provider(base_url: str) -> str:
    """根据 base_url 检测 provider 类型。"""
    bl = base_url.lower()
    for domain in _YUANBAO_DOMAINS:
        if domain in bl:
            return "tencent_maas"
    if "localhost" in bl or "127.0.0.1" in bl:
        return "local"
    return "standard"


class YuanbaoAdapter(ModelAdapter):
    """元宝模型适配器 — 针对 hy-mt2-pro 等弱工具调用模型的补救。"""

    def supports(self, model_config: dict[str, Any]) -> bool:
        base_url = str(model_config.get("base_url", ""))
        model = str(model_config.get("model", "")).lower()

        # 检测 base_url 域名
        if detect_provider(base_url) == "tencent_maas":
            return True

        # 检测模型名称
        for kw in _YUANBAO_MODELS:
            if kw in model:
                return True

        return False

    def handle_no_tool_calls(self, ctx: ModelAdapterContext) -> ModelAdapterContext:
        """元宝特定的重新 prompt 策略。"""
        text = ctx.model_output_text.strip()
        if not text or len(text) < 30:
            self._log(ctx, f"文本太短，不触发元宝补救")
            return ctx

        # 元宝特定 prompt
        self._log(ctx, f"元宝模型输出 {len(text)}ch 文本，触发工具调用补救")
        ctx.re_prompt_needed = True
        ctx.re_prompt_message = self._build_yuanbao_re_prompt(text, ctx.user_message)
        return ctx

    def _build_yuanbao_re_prompt(self, plan_text: str, original_request: str) -> str:
        """元宝特定的重新 prompt — 更强调工具调用的必要性。"""
        return f"""## ⚡ 紧急：工具调用执行阶段

你刚才输出了一段分析文本，但**没有调用任何工具**。
你的任务是使用提供的工具来实际执行操作，而不是描述计划。

**用户请求**：{original_request[:200]}

**你刚才的分析**：
```
{plan_text[:500]}
```

**现在请立即执行**：
1. 仔细查看可用工具列表中的所有工具
2. 选择最合适的工具并**调用它**（用实际的 tool_call）
3. 例如要扫描目录，就调用 scan_files 工具
4. 要解密文件，就调用 decrypt_file 工具
5. 要转换格式，就调用 transcode_file 工具

**重要**：不要输出任何分析文本，直接调用工具！"""


__all__ = ["YuanbaoAdapter", "detect_provider"]
