import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentTaskService, MVP_PROVIDER_ID } from "../application/agentTaskService";
import { PermissionPolicy } from "../application/settings/permissionPolicy";
import { ProviderRegistry } from "../application/providerRegistry";
import { ProviderRuntimeService } from "../application/providerRuntimeService";
import { ProviderRuntimeStartPolicy } from "../application/providerRuntimePolicy";
import { ProviderService } from "../application/providerService";
import { SessionPersistenceService } from "../application/agent/sessionPersistence";
import { FileSessionRepository } from "../infrastructure/sessionRepository";
import { AuthorizedMvpProviderGateway } from "../infrastructure/authorizedMvpProviderGateway";
import { PrivateProviderRuntimeGateway } from "../infrastructure/privateProviderRuntimeGateway";
import { FileSystemWorkspaceRepository } from "../infrastructure/workspaceRepository";

test("私有 Agent MVP 完成计划、审批、运行时、真实解密和 session 持久化闭环", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trimusic-agent-mvp-"));
  const install = path.join(root, "install");
  const persistence = new SessionPersistenceService(new FileSessionRepository());
  const workspaceRepository = new FileSystemWorkspaceRepository();
  const session = await workspaceRepository.createSession(root, new Date("2026-08-23T00:00:00.000Z"), "mvp-session");
  const registry = new ProviderRegistry();
  const provider = new ProviderService(registry, new AuthorizedMvpProviderGateway(path.join(process.cwd(), "src", "Presentation", "worker.py"), process.cwd(), path.join(process.cwd(), ".venv", "Scripts", "python.exe")), persistence);
  const runtime = new ProviderRuntimeService(new PrivateProviderRuntimeGateway(), registry, new ProviderRuntimeStartPolicy({ requestStartApproval: async () => true }), persistence);
  const permissions = new PermissionPolicy({ requestApproval: async () => true });
  const agent = new AgentTaskService(runtime, provider, permissions, persistence);
  try {
    await runtime.initialize({ root, session });
    const handle = agent.start(`请解密本地文件，输入 ${path.join(process.cwd(), "desktop", "tests", "fixtures", "sample.kgm")}，输出 ${path.join(root, "output")}`, "standard", { root, session });
    const result = await handle.completion;
    const snapshot = await persistence.load(root, session);
    assert.equal(result.taskId, handle.taskId);
    assert.equal((result.output as { success: boolean }).success, true);
    assert.equal(snapshot.tasks.some((task) => task.providerId === MVP_PROVIDER_ID && task.status === "completed"), true);
    assert.equal(snapshot.events.some((event) => event.eventType === "agent_plan_created"), true);
    assert.equal(snapshot.events.some((event) => event.eventType === "provider_call_completed"), true);
    assert.equal(snapshot.artifacts.some((artifact) => artifact.kind === "audio"), true);
  } finally { await runtime.stop(MVP_PROVIDER_ID, { root, session }).catch(() => undefined); await fs.rm(root, { recursive: true, force: true }); }
});
