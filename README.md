<div align="center">

# TriAgent

[![License: GPL v3](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](LICENSE)
![Python](https://img.shields.io/badge/python-3.10%2B-blue.svg)
![TypeScript](https://img.shields.io/badge/typescript-5.8%2B-blue.svg)
![Electron](https://img.shields.io/badge/electron-37%2B-blue.svg)

**基于大语言模型的本地音乐处理智能体**

Agent 自动扫描、解密、转码、整理你的音乐库。支持 QQ 音乐、酷狗、酷我、网易云四大平台的加密格式。

</div>

---

## 开发版声明

> TriAgent 目前处于开发版（Alpha）阶段，代码仍在快速迭代中，可能存在以下情况：
> - 已知和未知的 Bug
> - 界面交互不稳定
> - API 随时可能变更
> - 打包流程尚未稳定
>
> 如果你在使用中遇到问题，请务必提 Issues，附上详细的复现步骤和日志，我会尽快排查修复。

---

## 项目概述

**TriAgent** 是一个面向本地音乐文件处理场景的桌面智能体应用。通过自然语言指令驱动大语言模型，自动完成：

- 扫描加密音乐文件
- 解密各平台加密格式（kgm/kgma/kgg/mflac/mgg/ncm/kwm 等）
- 格式转换（mp3/flac/wav/m4a/ogg）
- 音频精细化处理（采样率、比特率、增益调整）
- 封面嵌入与元数据整理
- 完整性校验与去重

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | Electron 37 + React 19 + TypeScript 5.8 |
| 后端框架 | Python 3.10+ + LangChain/LangGraph |
| 编解码 | FFmpeg（格式转换与音频处理） |
| 数据库 | ChromaDB（向量存储/RAG） |
| 原生能力 | C + Frida（QQ/酷我运行期解密） |

### 基于框架做的开发

在 Electron + TypeScript 框架基础上，构建了：

1. 三层前端架构：Presentation / Application / Infrastructure 严格分层
2. 六边形后端架构：Presentation / Application / Domain / Infrastructure 端口适配器模式
3. Agent 工具系统：基于 JSON Schema 的工具清单协议（ToolManifest v1）
4. Provider 能力注册中心：可扩展的外部能力接入网关
5. 会话持久化与上下文压缩：基于 Token 预算的智能上下文管理
6. IPC 事件总线：结构化 Worker 事件桥，支持流式进度渲染

### 适配的服务

| 服务 | 说明 |
|------|------|
| 腾讯元宝 (Tencent Maas) | 深度适配：跳过 HEAD 预检、httpx 超时、thinking 参数兼容 |
| 智谱 GLM | 通用 OpenAI-compatible 接口 |
| 通用兼容 | 所有 OpenAI-compatible API 端点 |

---

## 项目架构

### 前端三层架构

```
+--------------------------------------------------+
| Presentation 展示层                               |
|  +-- renderer/ (React 组件、Hooks、UI)            |
|  +-- ipc/ (IPC Handler、事件发布)                 |
|  +-- preload.ts (Context Bridge)                 |
+--------------------------------------------------+
| Application 应用层                               |
|  +-- agent/ (AgentTaskService、会话持久化)        |
|  +-- model/ (ModelService、协议定义)             |
|  +-- provider/ (Provider 注册、运行时)            |
|  +-- tools/ (工具协议、清单)                      |
|  +-- worker/ (Worker 协议、服务)                 |
|  +-- settings/ (配置、权限策略)                   |
+--------------------------------------------------+
| Infrastructure 基础设施层                        |
|  +-- providers/ (Provider 网关、Manifest)        |
|  +-- repositories/ (仓库实现)                    |
|  +-- workers/ (Python Worker 客户端)             |
|  +-- logging/ (调试日志)                         |
+--------------------------------------------------+
```

### 后端六边形架构

```
+--------------------------------------------------+
| Presentation 表现层                              |
|  +-- cli/ (命令行入口)                            |
|  +-- worker/ (Worker 运行时)                     |
+--------------------------------------------------+
| Application 应用层                               |
|  +-- decrypt/ (解密编排服务)                     |
|  +-- services/ (Agent/Config/Kugou/Platform)    |
|  +-- transcode/ (转码服务)                       |
+--------------------------------------------------+
| Domain 领域层                                    |
|  +-- constants.py (业务常量)                     |
|  +-- models.py (领域模型)                        |
|  +-- ports.py (端口接口)                         |
+--------------------------------------------------+
| Infrastructure 基础设施层                        |
|  +-- adapters/agent/ (Agent 适配器集合)          |
|  +-- adapters/platforms/ (各平台解密适配器)      |
|  +-- adapters/media/ (媒体处理适配器)            |
|  +-- adapters/storage/ (存储适配器)              |
|  +-- di.py (依赖注入容器)                        |
+--------------------------------------------------+
```

### 架构约束

- SOLID 原则：所有模块严格遵守单一职责、开闭原则、里氏替换、接口隔离、依赖倒置
- 代码行数限制：单个文件不超过 300 行
- 子文件夹文件数：7 个文件为提醒线，10 个必须拆分为子文件夹
- 高内聚低耦合：每个子模块只暴露必要的公共 API

---

## 项目优势

- Agent 驱动：自然语言交互，自动规划多步骤任务
- 流式实时反馈：工具调用进度、思考过程、中间结果全可视
- 三级权限模式：受限 / 标准 / 完全访问，敏感操作需审批
- 会话持久化：任务恢复、历史追溯、上下文压缩
- 多平台全格式：QQ/酷狗/酷我/网易云，支持主流加密格式
- 去重优化：已处理文件自动跳过，支持批量断点续跑
- 可扩展架构：Provider 能力注册中心，新平台可快速接入
- 轻量前端：React + Electron，内存占用低

---

## 项目优化

| 优化项 | 说明 |
|--------|------|
| Token 预算管理 | 自动估算输入 Token，超限紧急压缩 |
| ToolMessage 截断 | 超过 1200 字符截断至 1200 + "(已截断)" |
| 历史消息修剪 | 仅保留最近 2 轮 ToolMessage |
| 轻量 Prompt 模式 | 简单任务使用精简 Prompt + 工具子集 |
| 即时处理 | 解密后立即处理（decrypt-and-process），非批量 |
| 去重索引 | `_processed_index.json` 防止重复处理 |
| 失败重试 | 转换失败自动重试，支持增量恢复 |
| 错误详情保留 | 完整错误信息提供给模型用于调试 |
| 中文行动说明 | Agent 在执行前输出中文行动规划 |
| 自我总结 | 达到递归限制时 Agent 自动总结已完成工作 |

---

## 工具协议

TriAgent 的工具系统基于 **ToolManifest v1 协议**，所有工具必须声明：

```typescript
interface ToolManifest {
  protocol_version: "1";
  tool_id: string;
  version: string;
  name: string;
  description: string;
  input_schema: JsonSchema;
  output_schema?: JsonSchema;
  capabilities: string[];
  permissions: PermissionMode[];
  events: string[];
  cancellation: boolean;
  timeout_ms: number;
  sensitive_operation?: SensitiveOperation;
}
```

- 协议版本：当前为 `v1`
- 权限模式：`restricted`（受限）/ `standard`（标准）/ `full`（完全访问）
- 敏感操作：`built-in` / `process` / `command` / `file-write` / `file-delete` / `network` / `log-read` / `task-resume` / `provider`
- 验证：所有工具注册时强制校验输入/输出 Schema

---

## 当前支持的平台

| 平台 | 能力 | 解密方式 |
|------|------|----------|
| 酷狗音乐 | kgma / kgm / kgg / vpr | 文件级离线解密 |
| QQ 音乐 | mflac / mgg / mmp4 | 运行期解密（需 QQ 进程配合） |
| 酷我音乐 | kwm / kwms | 运行期解密（需酷我进程配合） |
| 网易云音乐 | ncm | 文件级离线解密 |

---

## 快速开始

### 环境要求

- Node.js >= 20
- Python >= 3.10
- FFmpeg（音频转换依赖）

### 安装与运行

```powershell
# 克隆仓库
git clone <your-repo-url>
cd TriAgent

# 安装前端依赖
npm install

# 安装 Python 依赖
python -m venv .venv
.venv\Scripts\pip install -r requirements-private.txt

# 启动 Electron 开发模式
npm run start:electron
```

### 可用脚本

| 命令 | 说明 |
|------|------|
| `npm run start:electron` | 构建并启动 Electron |
| `npm run build:electron` | 仅构建 Electron 前端 |
| `npm run typecheck:electron` | TypeScript 类型检查 |
| `npm run test:electron` | 运行前端测试 |
| `npm run build:console` | 构建控制台版本 |
| `npm run build:ui` | 构建 PySide6 UI 版本 |
| `npm run package` | 打包发布版本 |

---

## 未完成事项

- 更多 LLM Provider 的深度适配
- Provider 运行时的独立安装流程
- 完整的 PySide6 UI 重构（当前 Electron 优先）
- 桌面打包与自动更新
- 正式的 Provider 部署与分发
- 更多平台的加密格式支持
- 移动端（iOS/Android）适配
- 多语言（i18n）支持

---

## 法律风险与免责声明

> 以下内容是工程合规说明，不构成法律意见。

### 你应当只在这些前提下使用本项目

- 仅处理你本人拥有合法访问权限的本地文件
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

---

## 第三方组件

请同时阅读：[THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md)

主要依赖：

- PySide6 / PySide6-Fluent-Widgets（UI 框架）
- FFmpeg（媒体处理）
- LangChain / LangGraph（Agent 框架）
- Frida（运行期解密）
- Unlock Music（酷狗解密逻辑，仅私有 Provider 边界）

---

## 贡献指南

详细的贡献规则、代码规范、PR 流程和评审标准请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 许可证

本仓库源码按 **GNU GPL v3** 发布：

[![License: GPL v3](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](LICENSE)

如果你计划进行商业使用、闭源分发或接入额外第三方组件，请先自行完成完整的许可证核验和风险评估。

---

## 致谢

- QQ 音乐解密模型思路参考：[qqmusic_decrypt](https://github.com/luyikk/qqmusic_decrypt)
- 网易云音乐解密模型参考 `ncmdump` 相关实现思路
- 酷狗解密逻辑基于 Unlock Music（仅私有 Provider 边界内使用）
- 其他平台相关逻辑以学习、研究和兼容性验证为目的持续整理

---

## 维护约定

每个任务在交接、验收或创建标签前，必须更新本 README，使入口、依赖、私有能力范围和验证命令与实现保持一致。
