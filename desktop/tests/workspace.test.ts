import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { WorkspaceService } from "../application/workspaceService";
import { FileSystemWorkspaceRepository, WorkspacePathError, validateWorkspaceCandidate } from "../infrastructure/workspaceRepository";
import { JsonSettingsRepository } from "../infrastructure/settingsRepository";

const testTempRoot = path.join(process.cwd(), ".tmp");

async function createTestRoot(prefix: string): Promise<string> {
  await mkdir(testTempRoot, { recursive: true });
  return mkdtemp(path.join(testTempRoot, prefix));
}

test("rejects C drive and installation subdirectories", () => {
  assert.throws(() => validateWorkspaceCandidate("C:\\TriMusicData", "D:\\Program Files\\TriMusicAgent"), (error: unknown) => error instanceof WorkspacePathError && error.code === "c-drive");
  assert.throws(() => validateWorkspaceCandidate("D:\\Program Files\\TriMusicAgent\\data", "D:\\Program Files\\TriMusicAgent"), (error: unknown) => error instanceof WorkspacePathError && error.code === "installation");
});

test("creates the required session layout without touching installation directory", async () => {
  const root = await createTestRoot("trimusic-agent-");
  const install = path.join(root, "install");
  const data = path.join(root, "data");
  try {
    const repository = new FileSystemWorkspaceRepository();
    await rm(install, { recursive: true, force: true });
    const prepared = await repository.prepareRoot(` ${data} `, install);
    assert.equal(prepared, path.resolve(data));
    const session = await repository.createSession(prepared, new Date("2026-08-22T10:20:30.000Z"), "session-test");
    assert.equal(session.relativePath, path.join("session", "2026", "08", "22", "session-test"));
    assert.match(session.relativePath, /^session[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]session-test$/);
    assert.deepEqual(JSON.parse(await readFile(path.join(prepared, session.relativePath, "session.json"), "utf8")), session);
    assert.equal(await repository.listSessions(prepared).then((items) => items[0].id), "session-test");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service exposes ready state and creates/selects empty sessions", async () => {
  const root = await createTestRoot("trimusic-agent-settings-");
  const settings = new JsonSettingsRepository(path.join(root, "settings", "settings.json"));
  const repository = new FileSystemWorkspaceRepository();
  const service = new WorkspaceService(repository, settings, path.join(root, "install"), () => new Date("2026-08-22T10:20:30.000Z"), () => "fixed-session");
  try {
    assert.equal((await service.initialize()).status, "needs-workspace");
    const ready = await service.chooseWorkspaceRoot(path.join(root, "data"));
    assert.equal(ready.status, "ready");
    assert.equal(ready.sessions.length, 0);
    const created = await service.createSession();
    assert.equal(created.selectedSessionId, "fixed-session");
    assert.equal((await service.selectSession("fixed-session")).selectedSessionId, "fixed-session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
