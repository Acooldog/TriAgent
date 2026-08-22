import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionInfo, WorkspaceRepository } from "../application/workspaceService";

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

export class WorkspacePathError extends Error {
  public constructor(public readonly code: "invalid" | "c-drive" | "installation" | "unwritable", message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export function validateWorkspaceCandidate(candidate: string, installationDir: string): void {
  const trimmed = candidate.trim();
  if (!trimmed || (!path.isAbsolute(trimmed) && !WINDOWS_ABSOLUTE_PATH.test(trimmed))) {
    throw new WorkspacePathError("invalid", "工作数据根目录必须是绝对路径。");
  }
  const comparable = comparablePath(trimmed);
  if (isCDrivePath(comparable)) {
    throw new WorkspacePathError("c-drive", "不能使用 C 盘路径作为工作数据根目录。");
  }
  if (isWithin(comparable, comparablePath(installationDir))) {
    throw new WorkspacePathError("installation", "不能使用安装目录或其子目录作为工作数据根目录。");
  }
}

export class FileSystemWorkspaceRepository implements WorkspaceRepository {
  public async prepareRoot(candidate: string, installationDir: string): Promise<string> {
    validateWorkspaceCandidate(candidate, installationDir);
    const requested = path.resolve(candidate.trim());
    try {
      await mkdir(requested, { recursive: true });
      const resolved = await realpath(requested);
      validateWorkspaceCandidate(resolved, installationDir);
      await access(resolved);
      const probe = path.join(resolved, `.trimusic-write-${randomUUID()}.tmp`);
      await writeFile(probe, "ok", { encoding: "utf8", flag: "wx" });
      await unlink(probe);
      return resolved;
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        throw error;
      }
      throw new WorkspacePathError("unwritable", "工作数据根目录不可写或无法创建。");
    }
  }

  public async createSession(root: string, now: Date, id: string): Promise<SessionInfo> {
    const year = String(now.getFullYear()).padStart(4, "0");
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const relativePath = path.join("session", year, month, day, id);
    const sessionDir = path.join(root, relativePath);
    await mkdir(path.dirname(sessionDir), { recursive: true });
    await mkdir(sessionDir, { recursive: false });
    const session: SessionInfo = { id, createdAt: now.toISOString(), relativePath };
    await writeFile(path.join(sessionDir, "session.json"), JSON.stringify(session, null, 2), "utf8");
    return session;
  }

  public async listSessions(root: string): Promise<SessionInfo[]> {
    const sessionsRoot = path.join(root, "session");
    const result: SessionInfo[] = [];
    for (const year of await readDirectories(sessionsRoot)) {
      for (const month of await readDirectories(path.join(sessionsRoot, year))) {
        for (const day of await readDirectories(path.join(sessionsRoot, year, month))) {
          const dayDir = path.join(sessionsRoot, year, month, day);
          for (const id of await readDirectories(dayDir)) {
            const session = await this.readSession(path.join(dayDir, id), id, path.relative(root, path.join(dayDir, id)));
            if (session) result.push(session);
          }
        }
      }
    }
    return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async readSession(directory: string, fallbackId: string, fallbackPath: string): Promise<SessionInfo | null> {
    try {
      const payload = JSON.parse(await readFile(path.join(directory, "session.json"), "utf8")) as Partial<SessionInfo>;
      if (typeof payload.id !== "string" || typeof payload.createdAt !== "string") return null;
      return { id: payload.id, createdAt: payload.createdAt, relativePath: payload.relativePath ?? fallbackPath };
    } catch {
      return { id: fallbackId, createdAt: new Date(0).toISOString(), relativePath: fallbackPath };
    }
  }
}

async function readDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return [];
    }
    throw error;
  }
}

function isMissingDirectoryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function comparablePath(value: string): string {
  if (WINDOWS_ABSOLUTE_PATH.test(value)) {
    return path.win32.normalize(value).replace(/[\\]+$/, "").toLowerCase();
  }
  return path.resolve(value).replace(/[\\]+$/, "").toLowerCase();
}

function isCDrivePath(value: string): boolean {
  return /^[c]:([\\/]|$)/i.test(value);
}

function isWithin(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`) || candidate.startsWith(`${parent}/`);
}
