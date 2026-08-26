import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { resolveProjectRoot, resolvePythonExecutable, resolveWorkerScript } from "../../infrastructure/workers/pythonRuntimePaths";

test("resolves the repository root from the bundled Electron main directory", () => {
  const root = path.resolve("O:/workspace/Qm-private-repo");
  const mainDir = path.join(root, "desktop", "dist");
  const workerScript = path.join(root, "desktop", "infrastructure", "publicWorker.py");
  const venvPython = path.join(root, ".venv", "Scripts", "python.exe");
  const existing = new Set([workerScript, venvPython]);
  const exists = (candidate: string) => existing.has(path.normalize(candidate));

  assert.equal(resolveProjectRoot(root, mainDir, exists), root);
  assert.equal(resolveWorkerScript(undefined, root, mainDir, exists), workerScript);
  assert.equal(resolvePythonExecutable(undefined, root, "win32", exists), venvPython);
});
