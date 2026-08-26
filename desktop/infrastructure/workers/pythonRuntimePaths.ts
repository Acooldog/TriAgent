import fs from "node:fs";
import path from "node:path";

type PathExists = (candidate: string) => boolean;

export function resolveProjectRoot(appPath: string, mainDirectory: string, exists: PathExists = fs.existsSync): string {
  const candidates = [path.resolve(mainDirectory, "..", ".."), appPath, path.resolve(appPath, "..", "..")];
  return candidates.find((candidate) => exists(path.join(candidate, "desktop", "infrastructure", "publicWorker.py"))) ?? appPath;
}

export function resolveWorkerScript(configuredPath: string | undefined, projectRoot: string, appPath: string, exists: PathExists = fs.existsSync): string {
  if (configuredPath && exists(configuredPath)) return configuredPath;
  const candidates = [
    path.join(projectRoot, "desktop", "infrastructure", "publicWorker.py"),
    path.join(appPath, "desktop", "infrastructure", "publicWorker.py"),
    path.resolve(appPath, "publicWorker.py"),
  ];
  return candidates.find(exists) ?? candidates[0];
}

export function resolvePythonExecutable(configuredPath: string | undefined, projectRoot: string, platform: NodeJS.Platform, exists: PathExists = fs.existsSync): string {
  if (configuredPath) return configuredPath;
  const executable = platform === "win32" ? path.join(projectRoot, ".venv", "Scripts", "python.exe") : path.join(projectRoot, ".venv", "bin", "python");
  return exists(executable) ? executable : "python";
}
