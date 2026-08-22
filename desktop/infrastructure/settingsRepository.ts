import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceSettings } from "../application/workspaceService";

interface SettingsPayload {
  workspaceRoot?: string;
}

export class JsonSettingsRepository implements WorkspaceSettings {
  public constructor(private readonly settingsFile: string) {}

  public async loadWorkspaceRoot(): Promise<string | null> {
    try {
      const payload = JSON.parse(await readFile(this.settingsFile, "utf8")) as SettingsPayload;
      return typeof payload.workspaceRoot === "string" && payload.workspaceRoot.trim() ? payload.workspaceRoot : null;
    } catch {
      return null;
    }
  }

  public async saveWorkspaceRoot(root: string): Promise<void> {
    await mkdir(path.dirname(this.settingsFile), { recursive: true });
    const temporary = `${this.settingsFile}.tmp`;
    await writeFile(temporary, JSON.stringify({ workspaceRoot: root }, null, 2), "utf8");
    await rename(temporary, this.settingsFile);
  }
}
