import { randomUUID } from "node:crypto";
import type { SessionPersistenceService, SessionSnapshot } from "../agent/sessionPersistence";

export type InitializationStatus = "needs-workspace" | "ready" | "error";

export interface SessionInfo { id: string; createdAt: string; relativePath: string; }

export interface WorkspaceState {
  status: InitializationStatus;
  message: string;
  workspaceRoot: string | null;
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  selectedSession: SessionSnapshot | null;
}

export interface WorkspaceRepository {
  prepareRoot(candidate: string, installationDir: string): Promise<string>;
  createSession(root: string, now: Date, id: string): Promise<SessionInfo>;
  listSessions(root: string): Promise<SessionInfo[]>;
}

export interface WorkspaceSettings { loadWorkspaceRoot(): Promise<string | null>; saveWorkspaceRoot(root: string): Promise<void>; }

export class WorkspaceService {
  private state: WorkspaceState = { status: "needs-workspace", message: "请选择可写的工作数据根目录。", workspaceRoot: null, sessions: [], selectedSessionId: null, selectedSession: null };
  private startupRecoveryPending = true;

  public constructor(
    private readonly repository: WorkspaceRepository,
    private readonly settings: WorkspaceSettings,
    private readonly installationDir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly persistence?: SessionPersistenceService,
  ) {}

  public getState(): WorkspaceState {
    return { ...this.state, sessions: [...this.state.sessions], selectedSession: this.state.selectedSession ? cloneSnapshot(this.state.selectedSession) : null };
  }

  public async initialize(): Promise<WorkspaceState> {
    let savedRoot: string | null;
    try { savedRoot = await this.settings.loadWorkspaceRoot(); } catch (error) { return this.setError(error, "读取工作区设置失败。", null); }
    if (!savedRoot) return this.getState();
    try { return await this.activateRoot(savedRoot, false); } catch (error) { return this.setError(error, "已保存的工作区不可用。", savedRoot); }
  }

  public async chooseWorkspaceRoot(candidate: string): Promise<WorkspaceState> {
    try { return await this.activateRoot(candidate, true); } catch (error) { return this.setError(error, "工作区不可用，请选择其他非 C 盘可写目录。", null); }
  }

  public async createSession(): Promise<WorkspaceState> {
    if (this.state.status !== "ready" || !this.state.workspaceRoot) return this.setError(new Error("工作区尚未初始化"), "请先选择工作区。", null);
    try {
      const session = await this.repository.createSession(this.state.workspaceRoot, this.now(), this.createId());
      this.state = { ...this.state, sessions: [session, ...this.state.sessions], selectedSessionId: session.id, selectedSession: await this.loadSnapshot(this.state.workspaceRoot, session), message: "已创建新会话。" };
    } catch (error) { this.setError(error, "创建会话失败。", this.state.workspaceRoot); }
    return this.getState();
  }

  public async selectSession(sessionId: string): Promise<WorkspaceState> {
    if (this.state.status !== "ready" || !this.state.workspaceRoot) return this.setError(new Error("工作区尚未初始化"), "请先选择工作区。", null);
    const selected = this.state.sessions.find((session) => session.id === sessionId);
    if (!selected) return this.setError(new Error("会话不存在"), "所选会话不可用。", this.state.workspaceRoot);
    this.state = { ...this.state, selectedSessionId: selected.id, selectedSession: await this.loadSnapshot(this.state.workspaceRoot, selected), message: "已选择会话。" };
    return this.getState();
  }

  public async refreshSelectedSession(): Promise<WorkspaceState> {
    if (this.state.workspaceRoot && this.state.selectedSessionId) {
      const selected = this.state.sessions.find((session) => session.id === this.state.selectedSessionId);
      if (selected) this.state = { ...this.state, selectedSession: await this.loadSnapshot(this.state.workspaceRoot, selected) };
    }
    return this.getState();
  }

  private async activateRoot(candidate: string, persist: boolean): Promise<WorkspaceState> {
    const root = await this.repository.prepareRoot(candidate, this.installationDir);
    const sessions = await this.repository.listSessions(root);
    if (this.persistence && this.startupRecoveryPending) for (const session of sessions) await this.persistence.recoverInterruptedTasks(root, session);
    if (persist) await this.settings.saveWorkspaceRoot(root);
    this.startupRecoveryPending = false;
    this.state = { status: "ready", message: "工作区已就绪。", workspaceRoot: root, sessions, selectedSessionId: sessions[0]?.id ?? null, selectedSession: sessions[0] ? await this.loadSnapshot(root, sessions[0]) : null };
    return this.getState();
  }

  private async loadSnapshot(root: string, session: SessionInfo): Promise<SessionSnapshot | null> {
    return this.persistence ? this.persistence.load(root, session) : null;
  }

  private setError(error: unknown, fallback: string, root: string | null): WorkspaceState {
    const detail = error instanceof Error && error.message ? error.message : "未知错误";
    this.state = { status: "error", message: `${fallback} ${detail}`, workspaceRoot: root, sessions: root ? this.state.sessions : [], selectedSessionId: root ? this.state.selectedSessionId : null, selectedSession: root ? this.state.selectedSession : null };
    return this.getState();
  }
}

function cloneSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return { ...snapshot, config: { ...snapshot.config }, messages: snapshot.messages.map((message) => ({ ...message })), state: { ...snapshot.state }, tasks: snapshot.tasks.map((task) => ({ ...task })), events: snapshot.events.map((event) => ({ ...event, payload: { ...event.payload } })), logs: snapshot.logs.map((log) => ({ ...log, context: log.context ? { ...log.context } : undefined })), artifacts: snapshot.artifacts.map((artifact) => ({ ...artifact, metadata: artifact.metadata ? { ...artifact.metadata } : undefined })), checkpoints: snapshot.checkpoints.map((checkpoint) => ({ ...checkpoint })) };
}
