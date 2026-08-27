/** workerEventDeps — Agent 事件处理依赖接口。
 *
 * ISP 修复：将 13 成员 WorkerEventDeps 拆分为 5 个按职责域划分的子接口。
 * 每个处理器只依赖自己需要的接口，避免胖接口。
 */
import type { Dispatch, SetStateAction } from "react";
import type {
  AgentQuestion,
  BatchProgressState,
  HistoryItem,
  LlmMessage,
  ToolEvent,
  AgentSegment,
} from "../useAppState.types";

/** Agent 启动/完成相关依赖。 */
export interface AgentLifecycleDeps {
  agentTaskIdRef: React.MutableRefObject<string | null>;
  setProcessing: Dispatch<SetStateAction<boolean>>;
  setProgress: Dispatch<SetStateAction<number>>;
  setTaskStatus: Dispatch<SetStateAction<string>>;
  setHistory: Dispatch<SetStateAction<HistoryItem[]>>;
  showToast: (msg: string) => void;
}

/** 工具调用相关依赖。 */
export interface ToolCallDeps {
  setToolEvents: Dispatch<SetStateAction<ToolEvent[]>>;
  setAgentSegments: Dispatch<SetStateAction<AgentSegment[]>>;
  setStepIndex: Dispatch<SetStateAction<number>>;
}

/** Agent 消息/思考相关依赖。 */
export interface AgentMessageDeps {
  setAgentMessages: Dispatch<SetStateAction<LlmMessage[]>>;
  toolActionPattern: RegExp;
  setAgentQuestion: Dispatch<SetStateAction<AgentQuestion | null>>;
}

/** 进度/批量处理相关依赖。 */
export interface ProgressDeps {
  setBatchProgress: Dispatch<SetStateAction<BatchProgressState>>;
}

/** 完整依赖接口（组合所有子接口，供需要全部依赖的处理器使用）。 */
export interface WorkerEventDeps
  extends AgentLifecycleDeps,
    ToolCallDeps,
    AgentMessageDeps,
    ProgressDeps {}
