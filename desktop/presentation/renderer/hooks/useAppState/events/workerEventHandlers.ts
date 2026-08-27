/** Worker event handlers — 事件处理门面。
 *
 * OCP 修复：switch-case 已迁移至 workerEventRegistry.ts 事件注册表。
 * ISP 修复：WorkerEventDeps 接口已按域拆分（见 workerEventDeps.ts）。
 * Primitive Obsession 修复：值对象类型见 workerEventTypes.ts。
 */
export { WorkerEventDeps } from "./workerEventDeps";
export type {
  AgentLifecycleDeps,
  AgentMessageDeps,
  ProgressDeps,
  ToolCallDeps,
} from "./workerEventDeps";
export {
  dispatchWorkerEvent as handleWorkerEvent,
  registerEventHandler,
  getRegisteredEventTypes,
} from "./workerEventRegistry";
export type { EventHandler } from "./workerEventRegistry";
export * from "./workerEventTypes";
