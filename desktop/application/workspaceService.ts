import { randomUUID } from "node:crypto";

export type InitializationStatus = "needs-workspace" | "ready" | "error";

export interface SessionInfo {
  id: string;
  createdAt: string;
  relativePath: string;
}

export interface WorkspaceState {
  status: InitializationStatus;
  message: string;
  workspaceRoot: string | null;
  sessions: SessionInfo[];
  selectedSessionId: string | null;
}

export interface WorkspaceRepository {
  prepareRoot(candidate: string, installationDir: string): Promise<string>;
  createSession(root: string, now: Date, id: string): Promise<SessionInfo>;
  listSessions(root: string): Promise<SessionInfo[]>;
}

export interface WorkspaceSettings {
  loadWorkspaceRoot(): Promise<string | null>;
  saveWorkspaceRoot(root: string): Promise<void>;
}

export class WorkspaceService {
  private state: WorkspaceState = {
    status: "needs-workspace",
    message: "请选择工作数据根目录。",
    workspaceRoot: null,
    sessions: [],
    selectedSessionId: null,
  };

  public constructor(
    private readonly repository: WorkspaceRepository,
    private readonly settings: WorkspaceSettings,
    private readonly installationDir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  public getState(): WorkspaceState {
    return {
      ...this.state,
      sessions: [...this.state.sessions],
    };
  }

  public async initialize(): Promise<WorkspaceState> {
    const savedRoot = await this.settings.loadWorkspaceRoot();
    if (!savedRoot) {
      return this.getState();
    }

    try {
      return await this.activateRoot(savedRoot, false);
    } catch (error) {
      return this.setError(error, "已保存的工作数据根目录不可用，请重新选择。", savedRoot);
    }
  }

  public async chooseWorkspaceRoot(candidate: string): Promise<WorkspaceState> {
    try {
      return await this.activateRoot(candidate, true);
    } catch (error) {
      return this.setError(error, "工作数据根目录不可用，请选择其他非 C 盘可写目录。", null);
    }
  }

  public async createSession(): Promise<WorkspaceState> {
    if (this.state.status !== "ready" || !this.state.workspaceRoot) {
      return this.setError(new Error("工作数据根目录尚未初始化。"), "请先选择工作数据根目录。", null);
    }

    try {
      const session = await this.repository.createSession(this.state.workspaceRoot, this.now(), this.createId());
      this.state = {
        ...this.state,
        sessions: [session, ...this.state.sessions],
        selectedSessionId: session.id,
        message: "已创建空会话。",
      };
    } catch (error) {
      this.setError(error, "创建空会话失败，请检查工作数据根目录权限。", this.state.workspaceRoot);
    }
    return this.getState();
  }

  public async selectSession(sessionId: string): Promise<WorkspaceState> {
    if (this.state.status !== "ready") {
      return this.setError(new Error("工作数据根目录尚未初始化。"), "请先选择工作数据根目录。", null);
    }
    const selected = this.state.sessions.find((session) => session.id === sessionId);
    if (!selected) {
      return this.setError(new Error("会话不存在。"), "找不到要选择的会话，请刷新列表。", this.state.workspaceRoot);
    }
    this.state = { ...this.state, selectedSessionId: selected.id, message: "已选择空会话。" };
    return this.getState();
  }

  private async activateRoot(candidate: string, persist: boolean): Promise<WorkspaceState> {
    const root = await this.repository.prepareRoot(candidate, this.installationDir);
    const sessions = await this.repository.listSessions(root);
    if (persist) {
      await this.settings.saveWorkspaceRoot(root);
    }
    this.state = {
      status: "ready",
      message: "工作数据根目录已就绪。",
      workspaceRoot: root,
      sessions,
      selectedSessionId: sessions[0]?.id ?? null,
    };
    return this.getState();
  }

  private setError(error: unknown, fallback: string, root: string | null): WorkspaceState {
    const detail = error instanceof Error && error.message ? error.message : "未知错误";
    this.state = {
      status: "error",
      message: `${fallback} ${detail}`,
      workspaceRoot: root,
      sessions: root ? this.state.sessions : [],
      selectedSessionId: root ? this.state.selectedSessionId : null,
    };
    return this.getState();
  }
}
