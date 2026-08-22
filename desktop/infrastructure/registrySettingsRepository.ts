import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspaceSettings } from "../application/workspaceService";

const execFileAsync = promisify(execFile);
const DEFAULT_KEY = "HKCU\\Software\\TriMusicAgent";

export class WindowsRegistrySettingsRepository implements WorkspaceSettings {
  public constructor(private readonly key = DEFAULT_KEY) {}

  public async loadWorkspaceRoot(): Promise<string | null> {
    try {
      const result = await execFileAsync("reg.exe", ["query", this.key, "/v", "WorkspaceRoot"], {
        windowsHide: true,
      });
      return parseWorkspaceRoot(result.stdout);
    } catch (error) {
      if (isRegistryValueMissing(error)) return null;
      throw new Error("读取工作数据根目录注册表设置失败。", { cause: error });
    }
  }

  public async saveWorkspaceRoot(root: string): Promise<void> {
    try {
      await execFileAsync(
        "reg.exe",
        ["add", this.key, "/v", "WorkspaceRoot", "/t", "REG_SZ", "/d", root, "/f"],
        { windowsHide: true },
      );
    } catch (error) {
      throw new Error("保存工作数据根目录注册表设置失败。", { cause: error });
    }
  }
}

function parseWorkspaceRoot(output: string): string | null {
  const match = output.match(/^\s*WorkspaceRoot\s+REG_SZ\s+(.*)$/im);
  const root = match?.[1]?.trim();
  return root ? root : null;
}

function isRegistryValueMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === 1;
}
