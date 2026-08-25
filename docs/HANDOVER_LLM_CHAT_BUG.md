# 交接文档：LLM Chat 页面不渲染模型回复

## 现象
- LLM Chat 页面发送消息后，模型回复文本不显示
- 分割线（divider）正常显示
- 用户消息正常显示
- 终端确认模型有返回（reasoning_delta + text_delta 事件均有 token 数据）

## 根因分析

### 最终确认

`registerIpc()` 在 `createWindow()` 之前执行，并在注册时解构了 `ctx.mainWindow`。当时窗口尚未创建，因此局部变量永久保存为 `null`；后续 `publishModelEvent()` 虽然输出了发布日志，但可选链直接跳过了 `webContents.send()`。

修复使用动态窗口访问器，在每次发布事件时重新读取当前 `ctx.mainWindow`。同一问题影响的模型、Worker、Provider、Agent 和持久化事件发送路径一并改为动态读取；工作区目录选择也不再使用注册时捕获的窗口引用。

### 事件链路追踪

```
模型 API → parseSseResponse()
  → onEvent({ type: "text_delta", text: delta.content })
  → modelService.stream() 回调
  → ipcHandlers.publishModelEvent(requestId, event)
  → mainWindow.webContents.send("model:event", { requestId, event })   ← ❌ 实际窗口引用为注册时捕获的 null
  → preload.ts onModelEvent handler (ipcRenderer.on)                   ← ❓ 断点可能在此
  → useAppState.ts useEffect onModelEvent listener                      ← ❌ 无任何日志
  → React setState → LlmChat.tsx 渲染                                   ← ❌ 无输出
```

### 关键证据（用户终端日志）

主进程侧日志（全部正常）：
```
[TriMusicAgent][model-ipc] event { type: 'reasoning_delta' }     ← 有数据
[TriMusicAgent][model-ipc] publish-event { type: 'reasoning_delta' }  ← 已发布
[TriMusicAgent][model-ipc] event { type: 'text_delta' }           ← 有数据
[TriMusicAgent][model-ipc] publish-event { type: 'text_delta' }       ← 已发布
[TriMusicAgent][model-ipc] event { type: 'response_completed' }   ← 完成
[TriMusicAgent][model-ipc] publish-event { type: 'response_completed' }
```

Renderer 侧日志（完全缺失）：
```
[useAppState] text-delta: ...           ← 从未出现
[useAppState] response-completed: ...  ← 从未出现
```

**结论：事件未能从主进程到达 Renderer 进程，根因是 IPC 注册阶段捕获了尚未创建的窗口引用。**

## 涉及文件

| 文件 | 作用 | 相关行 |
|------|------|--------|
| `desktop/presentation/main.ts` | 创建 BrowserWindow，加载 preload | L87: `preload: path.join(__dirname, "preload.cjs")` |
| `desktop/presentation/preload.ts` | contextBridge 暴露 API 到 renderer | L43-47: `onModelEvent` 桥接 |
| `desktop/presentation/ipcHandlers.ts` | 注册 IPC handler，发布模型事件 | L106-118: `publishModelEvent` |
| `desktop/presentation/renderer/hooks/useAppState.ts` | Renderer 侧状态管理，注册事件监听 | L133-186: useEffect 注册 onModelEvent |
| `desktop/presentation/renderer/components/LlmChat.tsx` | UI 渲染组件 | L4-12: 解构 state, L194-198: debug 面板 |

## 已完成的修复尝试（当前代码中）

### 1. reasoning_delta 文本累加（已实现）
`useAppState.ts` L146-150：reasoning_delta 事件现在也会累加到 `llmReasoningRef`，完成时作为 text_delta 的回退。

### 2. UI 可见 Debug 面板（已实现）
`LlmChat.tsx` L194-198：底部 DEBUG 面板显示最近事件信息。如果此面板不出现，说明事件完全没到达 renderer。

### 3. 详细控制台日志（已实现）
`useAppState.ts` L145, L172：每次 text_delta 和 response_completed 都有 console.info。

## 排查建议（给 Codex）

### 优先级 1：验证 preload 是否正确加载
检查 `preload.cjs` 是否在 renderer 中正确执行。在 preload.ts 的 `onModelEvent` 注册处加 `console.log("PRELOAD: onModelEvent registered")`。

### 优先级 2：验证 contextBridge 是否暴露了 triMusicAgent
在 `useAppState.ts` 的 useEffect 开头加：
```typescript
console.log("DEBUG: window.triMusicAgent =", !!window.triMusicAgent);
console.log("DEBUG: window.triMusicAgent.onModelEvent =", !!window.triMusicAgent?.onModelEvent);
```

### 优先级 3：验证 ipcRenderer.on 是否收到事件
在 preload.ts L43-47 的 handler 内加 `console.log("PRELOAD: received model:event", envelope)`。

### 优先级 4：验证 mainWindow 是否有效
在 `ipcHandlers.ts` L109 加 `debugInfo("DEBUG", "mainWindow exists:", !!mainWindow, "webContents:", !!mainWindow?.webContents)`。

### 优先级 5：检查 Electron 构建产物
确认 `desktop/dist/preload.cjs` 文件存在且是最新构建的。运行 `npm run build:electron` 后检查。

### 优先级 6：检查 requestId 是否匹配
`useAppState.ts` L138 检查 `requestId !== llmRequestIdRef.current`。如果 ref 为 null 或不匹配，事件会被静默丢弃。在 L138 前加日志：
```typescript
console.log("DEBUG: requestId check", { eventRequestId: requestId, refRequestId: llmRequestIdRef.current });
```

## 技术背景

- Electron 应用，contextIsolation: true，sandbox: true
- Preload 脚本通过 contextBridge 暴露 API
- IPC 事件通过 `ipcRenderer.on("model:event", handler)` 从主进程到达渲染进程
- 模型事件格式：`{ requestId: string, event: ModelEvent }`
- ModelEvent 类型：`text_delta | reasoning_delta | tool_call_delta | response_completed | error`

## 备注
- 分支：`add/mvp-prototype-decrypt`
- 最新 commit：`13860a8`（消息：trae）
- 推送到：`private` remote（GitHub）
