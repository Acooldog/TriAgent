"""多 Agent 协作架构（策略 B：ThreadPool 并行 + 精简工具集）。

模块结构:
- tool_registry.py  : 按职责拆分 ALL_TOOLS，子 Agent 只暴露必要工具
- sub_agent.py      : 封装 run_sub_agent()，复用 run_agent 的 LLM + stream + 超时机制
- orchestrator.py   : 主 Agent 调度器，ThreadPool 并发跑多个子 Agent
                      QQ 解密操作用 threading.Lock 串行化（Frida 约束）

Feature Flag: MULTI_AGENT_ENABLED = True（用户可关闭降级为单 Agent）
"""

from src.Infrastructure.multi_agent.tool_registry import (
    DECRYPT_TOOLS,
    TRANSCODE_TOOLS,
    VERIFY_TOOLS,
    get_tools_by_role,
)
from src.Infrastructure.multi_agent.sub_agent import run_sub_agent
from src.Infrastructure.multi_agent.orchestrator import (
    OrchestratorAgent,
    MULTI_AGENT_ENABLED,
)

__all__ = [
    "DECRYPT_TOOLS",
    "TRANSCODE_TOOLS",
    "VERIFY_TOOLS",
    "get_tools_by_role",
    "run_sub_agent",
    "OrchestratorAgent",
    "MULTI_AGENT_ENABLED",
]
