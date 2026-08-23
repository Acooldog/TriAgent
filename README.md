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
