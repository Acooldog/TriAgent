import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppSettings, DEFAULT_APP_SETTINGS, type AppSettingsRepository } from "../application/appSettings";
import type { WorkspaceSettings } from "../application/workspaceService";

export class JsonSettingsRepository implements AppSettingsRepository, WorkspaceSettings {
  public constructor(private readonly settingsFile: string) { }

  public async load(): Promise<AppSettings> {
    try {
      const payload = JSON.parse(await readFile(this.settingsFile, "utf8")) as Partial<AppSettings>;
      return mergeWithDefaults(payload);
    } catch {
      return structuredClone(DEFAULT_APP_SETTINGS);
    }
  }

  public async save(settings: Partial<AppSettings>): Promise<void> {
    const current = await this.load();
    const merged = deepMerge(current as unknown as Record<string, unknown>, settings as Record<string, unknown>) as unknown as AppSettings;
    await this.writeAtomic(merged);
  }

  public async reset(): Promise<AppSettings> {
    const defaults = structuredClone(DEFAULT_APP_SETTINGS);
    await this.writeAtomic(defaults);
    return defaults;
  }

  public async loadWorkspaceRoot(): Promise<string | null> {
    const settings = await this.load();
    return settings.workspace.workspaceRoot;
  }

  public async saveWorkspaceRoot(root: string): Promise<void> {
    await this.save({ workspace: { workspaceRoot: root } });
  }

  private async writeAtomic(settings: AppSettings): Promise<void> {
    await mkdir(path.dirname(this.settingsFile), { recursive: true });
    const temporary = `${this.settingsFile}.tmp`;
    await writeFile(temporary, JSON.stringify(settings, null, 2), "utf8");
    await rename(temporary, this.settingsFile);
  }
}

function mergeWithDefaults(payload: Partial<AppSettings>): AppSettings {
  const defaults = structuredClone(DEFAULT_APP_SETTINGS);
  return deepMerge(defaults as unknown as Record<string, unknown>, payload as Record<string, unknown>) as unknown as AppSettings;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === undefined) continue;
    const targetValue = result[key];
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else {
      result[key] = sourceValue;
    }
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
