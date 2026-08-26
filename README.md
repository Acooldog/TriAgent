<div align="center">

# QKKDecrypt | QQ 酷狗酷我网易云音乐解密工具

### TriMusicAgent Task 4: session persistence

The Electron Agent core mirrors the public session contract: append-only `conversation.jsonl`, redacted `config.json`, task state files, `events.jsonl`, logs, artifact references, and recoverable checkpoints. Startup restores stopped state and the UI displays a collapsible operation timeline. Context compression preserves raw messages, optionally writes Markdown when the token-cost threshold is met, and falls back without replacing the original conversation.

<img src="./封面/封面.png" width="320" alt="QKKDecrypt cover">


</div>

## 项目定位

`QKKDecrypt` 是一个面向本地文件处理场景的桌面/控制台工具集：
- 控制台版本：批处理、自动化、脚本化操作
- UI 版本：面向普通用户的桌面工作台
- 架构保持三层：`Presentation / Application / Infrastructure`；模块遵循 SOLID，并以低耦合、高内聚为边界原则

### TriMusicAgent Electron MVP

Electron Agent 工作区目前处于 MVP 阶段，开发入口为：

```powershell
npm run start:electron
```

它提供工作数据根目录选择、空会话创建与会话选择。运行数据必须写入用户选择的非 `C:` 盘、且不能是安装目录；会话按 `session/YYYY/MM/DD/<session-id>/` 保存。Windows 下最近使用的工作数据根目录保存在当前用户注册表，不写入安装目录或 `C:` 盘文件。

Electron 相关验证命令：

```powershell
npm run build:electron
npm run typecheck:electron
npm run test:electron
```

### 外部能力 Provider 合同与运行时边界（MVP 任务 5-6）

Electron Agent 核心已与公开仓库同步 provider 合同：版本化 manifest、能力清单、输入/输出 Schema、权限、事件、取消和超时声明，以及发现、原子刷新、启用/禁用、健康状态、调用结果和统一错误。只有注册、启用、健康且通过调用校验的 provider 能力可以执行。

Renderer 提供中文 Provider 清单、健康检查、启用状态、JSON 参数调用、权限选择、取消、脱敏结果和默认折叠事件；事件、任务状态、日志和产物引用写入当前 session。应用重启后，运行中的 Provider 任务恢复为停止状态并写入恢复时间线，不自动重试。

共享 Application、Presentation、通用 Infrastructure 和合同测试与公开仓库保持一致。运行时状态机现在覆盖发现、启动审批、握手、健康、停止、取消、超时、崩溃截停和应用重启恢复；状态、脱敏事件、日志和运行时任务写入当前 session。专有能力的适配、运行时资源和 provider-specific 测试继续限定在私有 Infrastructure/测试边界，不改变公开合同，也不把内部调用细节写入公开仓库。

接入配置以协议版本 `1` 的 manifest 和 `ProviderGateway` 为边界。未接入运行时 gateway 时，界面会显示未发现 Provider。合同回归覆盖注册、版本、重复 ID、Schema、权限、缺失、健康失败、终态与迟到事件、非阻塞取消、超时、异步终态可见、错误和本地路径脱敏、刷新原子性、session 写入和重启恢复。

运行时管理界面使用中文显示“未配置、已停止、启动中、健康、异常、停止中”状态，并提供启动、健康检查、停止和恢复建议。受限模式拒绝启动，标准模式要求用户审批，完全访问模式允许自动启动；Provider 异常退出后不会盲目重试。具体 provider 的部署、运行时资源和专有适配仍属于本私有仓库范围，尚未形成面向最终用户的独立安装流程。

### 会话持久化与上下文压缩

每个会话保存只追加的 `conversation.jsonl`、脱敏 `config.json`、任务状态、事件、日志、产物引用和可恢复检查点。应用重启后会恢复操作时间线和停止状态；压缩检查点作为后续模型请求的活动上下文，用户可以随时恢复原始上下文。

Markdown 检查点仅在估算成本明显更低时生成。API Key、认证 Token、Cookie 和其他敏感请求头不会进入持久化文件。普通 Agent 会话实现与公开仓库保持同步，私有 provider 只保留必要的专有入口差异。

任务 2 已接入 Python worker JSON Lines 事件桥：Electron 主进程负责 worker 启动、取消、超时、回收和 IPC 转发，Renderer 只订阅结构化事件；Python worker 通过 `request_id`、`task_id`、`event_type`、`status`、`payload` 和 `error` 报告状态。真实解密、模型接入、权限审批、工具协议和打包交付仍按 MVP 任务清单逐步接入。

当前仓库源码统一按 **GPLv3** 发布；UI 路线采用 **PySide6 + QFluentWidgets** 的非商业 GPLv3 路线持续重构。

## 分支说明

- `main`
  - 控制台版本
  - 薄入口 `main.py`
  - 打包形态：`onefile`
- `main-ui`
  - PySide6 桌面 UI 版本
  - 保留无边框、Win10/11 风格、亚克力效果与动态进度反馈
  - 打包形态：`onedir + _internal + setup`

## 当前支持的平台

- `QQ音乐`
  - 运行期解密
  - 需要 QQ 音乐进程配合
- `酷我音乐`
  - 运行期解密
  - 需要酷我进程配合
- `酷狗音乐`
  - 文件级离线解密
- `网易云音乐`
  - 文件级离线解密

## Python UI 路线

UI 版本继续使用 **PySide6**，并逐步引入 **QFluentWidgets** 做导航、卡片和桌面风格控件，目标体验参考 Steam++：
- 左侧导航栏
- 页面分区明确
- 设置页面独立
- 小窗口/辅助页独立
- 无边框桌面体验
- 动态进度反馈与现代化状态提示

## 打包

```powershell
npm run package
```

默认会构建：
- `QKKDecrypt.exe`
- `QKKDecrypt-UI-setup.exe`

## 合规与风险边界

以下内容是工程合规说明，不构成法律意见。

### 你应当只在这些前提下使用本项目
- 仅处理你本人拥有**合法访问权限**的本地文件
- 自行确认你的使用行为符合所在地法律、版权规则、平台协议和组织政策
- 不要把本项目用于批量分发、倒卖、牟利或规避付费授权

### 项目不承诺这些事情
- 不承诺适用于所有地区、所有平台规则、所有用途
- 不承诺一定符合你所在地区的合规要求
- 不承诺任何特定商业用途可直接使用
- 不为用户的侵权、违约或违规使用承担责任

### 对外发布建议口径
如果你二次分发、改包或转载，请至少保留下列表达：

> 本项目按 GPLv3 发布，仅面向学习、研究与本地文件处理场景。使用者应仅处理自己拥有合法访问权限的文件，并自行确认其行为符合适用法律、版权规则及平台协议。项目作者不对非法或违规用途负责。

## 第三方组件说明

请同时阅读：
- [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md)

当前需要特别注意：
- `PySide6`
- `PySide6-Fluent-Widgets`
- `FFmpeg`
- 其他运行期依赖和打包依赖

## 致谢

- QQ 音乐解密模型思路参考项目：
  - [`qqmusic_decrypt`](https://github.com/luyikk/qqmusic_decrypt)
- 网易云音乐解密模型参考 `ncmdump` 相关实现思路
- 其他平台相关逻辑以学习、研究和兼容性验证为目的持续整理

## 维护约定

每个任务在交接、验收或创建标签前，必须更新本 README，使入口、依赖、私有能力范围和验证命令与实现保持一致。

## 许可证

本仓库源码按 **GNU GPL v3** 发布：
- [LICENSE](./LICENSE)

如果你计划进行商业使用、闭源分发或接入额外第三方组件，请先自行完成完整的许可证核验和风险评估。
## 权限、预算与 C 端诊断（MVP 任务 7）

Electron Agent 现在统一支持受限、标准、完全访问三档权限。敏感操作在受限模式拒绝，标准模式请求中文一次性审批，完全访问模式自动执行；联网按会话默认关闭，错误搜索仅发送脱敏摘要，不发送音频、凭据或完整本地路径。私有 Provider 运行时仍通过公开 `ProviderRuntimeGateway` 合同接入，具体实现、资源和命令不进入公开仓库。

任务预算限制为单步骤最多重试 2 次、最多 8 轮模型交互、16 次工具调用和 15 分钟总超时。超时、取消、重复错误和预算耗尽立即截停，并写入 session 任务、事件和日志。桌面“运行诊断”检查 FFmpeg、模型、Python worker、session 与 Provider，并展示中文错误分类、脱敏摘要、日志位置和恢复建议；错误搜索无结果即停止。

任务 7 验证命令：

```powershell
npm run build:electron
npm run typecheck:electron
npm run test:electron
npm run build:console
npm run build:ui
```

## Electron 原型迁移与可解密本地 MVP

正式 Electron Renderer 直接加载迁移后的原型入口和资源，保留处理台、模型服务、当前任务、音乐库、任务历史、诊断中心、设置、审批、错误恢复、会话压缩、流式输出、停止和时间线折叠交互。原型按钮通过 Presentation 层 bridge 接入 Application IPC，不再把模拟状态当作真实结果。

启动：`npm run start:electron`。若本地没有 Python 虚拟环境，先创建 `.venv`，再执行 `.venv\Scripts\python.exe -m pip install -r requirements-private.txt` 安装私有运行时依赖；然后选择非 C 盘工作区、创建会话、配置通用 OpenAI-compatible 模型并提交自然语言解密任务。私有版本使用一个授权的本地 Provider 完成 KGM v3 到 MP3 的可验证闭环，输出、session、日志、时间线、产物引用、取消、失败恢复和重启停止状态均由现有持久化协议记录。

模型设置页提供 API Key、Thinking、最大 Token 和 Temperature。智谱 GLM-4.5 配置示例：Base URL `https://open.bigmodel.cn/api/paas/v4`，模型名 `glm-4.5`，Thinking `enabled`，最大 Token `4096`，Temperature `0.6`。保存设置和测试连接均通过 Electron IPC 执行，API Key 不写入 session 或日志。

模型、Worker、Provider、Agent 和持久化事件会在发送时读取当前 Electron 窗口，避免 IPC 早于窗口创建注册时丢失 Renderer 事件；模型的流式推理与回复文本可在会话页面持续渲染。

Agent 任务会在开始处理和调用工具前发送简短的中文行动说明，例如先核对路径、扫描文件、再执行解密；这些消息描述可见计划和当前动作，不展示模型的隐含推理。Python Worker 强制使用 UTF-8，并按完整字符和完整行转发 stdout/stderr，避免中文日志乱码或拆成多条事件。开发模式会从仓库根目录自动发现 `.venv` 和 Worker 入口。

## 调试日志

启动后按 `Ctrl+Shift+I` 打开 Electron 开发者工具，在 Console 查看 `[TriMusicAgent][renderer]`、`[bridge]`、`[main]`、`[model-client]`、`[agent]`、`[provider]`、`[runtime]` 和 `[worker]` 日志。日志覆盖点击、IPC、模型请求、审批、Provider 生命周期、进度、取消、超时和错误；API Key、Token、Cookie、Authorization 等敏感值会自动脱敏。

酷狗能力按要求优先使用 Unlock Music 逻辑；该逻辑仅位于私有 Provider 边界，许可证核对记录见 `docs/third-party/unlock-music-license.md`。公开仓库不包含私有 Provider 的代码、资源、命令、参数或内部调用细节。任务 8 及之后的安装包、升级器、完整多格式回归和正式发布尚未执行。
