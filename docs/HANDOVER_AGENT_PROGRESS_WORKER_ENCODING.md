# Agent 主动进度消息与 Worker 编码修复交接

## 固定点

- Trae 提交：`bbaaac6`
- 修复分支：`fix/agent-progress-messages`

## 用户目标

Agent 在执行任务前和关键工具调用前，像 Coding Agent 一样先发送简短的中文行动说明，并在执行过程中继续汇报可见进度。行动说明不包含隐含推理过程。

## 根因

1. UI 已支持渲染 `agent_message`，但模型直接调用工具时不会产生前置文本。
2. Windows Python 子进程可能使用系统代码页输出，Node 按 UTF-8 解码后产生乱码。
3. 即使输出编码为 UTF-8，多字节中文跨 stream chunk 时，逐 chunk `toString()` 仍会破坏字符。
4. 目标 `.venv` 缺少 `langchain-openai`；`agent_executor` 本身约 0.66 秒即可导入，并未复现真正的 import 卡死。
5. 开发模式的项目根目录推导可能多退两级，导致无法发现仓库内 `.venv`。
6. Agent Worker 在导入 `numpy` 前启动了阻塞 stdin 的取消监听线程；Windows 管道保持开启时会导致 `numpy` 导入死锁。

## 修复

- 任务启动时发送与用户目标相关的 `agent_message`。
- 模型未先说明而直接调用工具时，自动补充对应工具的行动说明。
- Worker 子进程设置 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`，Python 入口再次配置 stdout/stderr 为 UTF-8。
- Node 使用持续 UTF-8 解码器，并按完整行转发 stderr。
- 新增纯路径解析模块，稳定发现仓库根目录、Worker 入口和 `.venv`。
- `requirements-private.txt` 显式声明 `langchain-openai`。
- Agent 操作在完整运行时导入后才启动 stdin 取消监听；导入期间取消仍由 Electron 的进程终止兜底。
- `agent_log` 的实际级别和脱敏消息写入当前会话 `logs.jsonl`，非日志事件继续使用紧凑事件名。
- Renderer 不消费或展示 `agent_log`，任务页只保留行动说明、工具进度和结果。

## 安全说明

- 未把 API Key、完整令牌或凭据写入源码、测试、README、交接文档或日志。
- 端到端联网测试需要用户自行使用本地已保存配置，不在自动测试中发送真实凭据。
