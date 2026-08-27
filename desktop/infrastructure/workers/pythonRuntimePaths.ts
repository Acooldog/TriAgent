import fs from "node:fs";
import path from "node:path";

type PathExists = (candidate: string) => boolean;

const PACKAGED_WORKER_DIR = "python-worker";
const WORKER_EXE_NAME = "triagent-worker";

export function resolveProjectRoot(appPath: string, mainDirectory: string, exists: PathExists = fs.existsSync): string {
  if (exists(path.join(appPath, PACKAGED_WORKER_DIR))) {
    return appPath;
  }
  const candidates = [path.resolve(mainDirectory, "..", ".."), appPath, path.resolve(appPath, "..", "..")];
  return candidates.find((candidate) => exists(path.join(candidate, "desktop", "infrastructure", "workers", "publicWorker.py"))) ?? appPath;
}

export function resolveWorkerScript(configuredPath: string | undefined, projectRoot: string, appPath: string, exists: PathExists = fs.existsSync): string {
  if (configuredPath && exists(configuredPath)) return configuredPath;

  const packagedExe = resolvePackagedWorkerExe(appPath, exists);
  if (packagedExe) return packagedExe;

  const candidates = [
    path.join(projectRoot, "desktop", "infrastructure", "workers", "publicWorker.py"),
    path.join(appPath, "desktop", "infrastructure", "workers", "publicWorker.py"),
    path.resolve(appPath, "publicWorker.py"),
  ];
  return candidates.find(exists) ?? candidates[0];
}

export function resolvePythonExecutable(configuredPath: string | undefined, projectRoot: string, platform: NodeJS.Platform, exists: PathExists = fs.existsSync): string {
  if (configuredPath) return configuredPath;

  const packagedExe = resolvePackagedWorkerExe(projectRoot, exists);
  if (packagedExe) return "";

  const executable = platform === "win32" ? path.join(projectRoot, ".venv", "Scripts", "python.exe") : path.join(projectRoot, ".venv", "bin", "python");
  return exists(executable) ? executable : "python";
}

export function resolvePackagedWorkerExe(appPath: string, exists: PathExists = fs.existsSync): string | null {
  const exeName = process.platform === "win32" ? `${WORKER_EXE_NAME}.exe` : WORKER_EXE_NAME;
  const candidates = [
    path.join(appPath, PACKAGED_WORKER_DIR, exeName),
    path.resolve(appPath, exeName),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function isWorkerBundled(appPath: string, exists: PathExists = fs.existsSync): boolean {
  return resolvePackagedWorkerExe(appPath, exists) !== null;
}
