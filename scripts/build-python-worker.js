const fs = require("fs");
const path = require("path");
const { run, fail, ensureDir, ensureFile, resolvePythonExe } = require("../script/build-lib");

const rootDir = path.resolve(__dirname, "..");
const srcDir = path.join(rootDir, "src");
const workerEntry = path.join(rootDir, "desktop", "infrastructure", "workers", "publicWorker.py");
const outputDir = path.join(rootDir, "dist", "python-worker");
const buildDir = path.join(rootDir, "build", "python-worker");
const exeName = "triagent-worker";

function checkPyInstaller() {
  const pyExe = resolvePythonExe(rootDir);
  try {
    run(pyExe, ["-c", "import PyInstaller; print(PyInstaller.__version__)"], { cwd: rootDir });
    return pyExe;
  } catch {
    console.log("[build-python-worker] PyInstaller not found, installing...");
    run(pyExe, ["-m", "pip", "install", "pyinstaller", "--quiet"], { cwd: rootDir });
    return pyExe;
  }
}

function buildPythonWorker() {
  const pyExe = checkPyInstaller();

  ensureFile(workerEntry, "worker entry point");

  console.log("[build-python-worker] Cleaning previous build...");
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.rmSync(outputDir, { recursive: true, force: true });

  ensureDir(buildDir);

  console.log("[build-python-worker] Building Python worker with PyInstaller...");

  const pyInstallerArgs = [
    "-m", "PyInstaller",
    "--noconfirm",
    "--clean",
    "--onedir",
    `--name=${exeName}`,
    `--paths=${rootDir}`,
    `--paths=${srcDir}`,
    `--distpath=${outputDir}`,
    `--workpath=${path.join(buildDir, "work")}`,
    `--specpath=${buildDir}`,
    "--collect-all=langchain",
    "--collect-all=langchain_core",
    "--collect-all=langchain_community",
    "--collect-all=langchain_openai",
    "--collect-all=sentence_transformers",
    workerEntry,
  ];

  run(pyExe, pyInstallerArgs, { cwd: rootDir, timeoutMs: 300000 });

  const exePath = path.join(outputDir, exeName, process.platform === "win32" ? `${exeName}.exe` : exeName);
  if (!fs.existsSync(exePath)) {
    fail(`PyInstaller build failed: ${exeName} not found at ${exePath}`);
  }

  console.log(`[build-python-worker] Python worker built: ${exePath}`);
  return exePath;
}

function main() {
  console.log(`[build-python-worker] Building ${exeName}...`);
  const exePath = buildPythonWorker();
  console.log(`[build-python-worker] Done: ${exePath}`);
}

main();
