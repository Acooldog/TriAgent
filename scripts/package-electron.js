const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const desktopDir = path.join(rootDir, "desktop");
const distDir = path.join(desktopDir, "dist");
const electronDistDir = path.join(rootDir, "dist", "electron");
const pythonWorkerDir = path.join(rootDir, "dist", "python-worker");
const releaseDir = path.join(rootDir, "release");

const appName = "TriAgent";

function log(step, message) {
  console.log(`[package:electron] ${step} ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    timeout: 600000,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function cleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  ensureDir(dirPath);
}

function copyRecursive(sourceDir, targetDir) {
  if (fs.statSync(sourceDir).isFile()) {
    ensureDir(path.dirname(targetDir));
    fs.copyFileSync(sourceDir, targetDir);
    return;
  }
  ensureDir(targetDir);
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(src, dst);
    } else {
      ensureDir(path.dirname(dst));
      fs.copyFileSync(src, dst);
    }
  }
}

function stepBuildElectron() {
  log("1/4", "Building Electron frontend...");
  run("node", [path.join(rootDir, "scripts", "build-electron.js")], { cwd: rootDir });
}

function stepBuildPythonWorker() {
  log("2/4", "Building Python worker (standalone exe)...");
  run("node", [path.join(rootDir, "scripts", "build-python-worker.js")], { cwd: rootDir });
}

function stepStageAssets() {
  log("3/4", "Staging assets for electron-builder...");

  cleanDir(electronDistDir);
  cleanDir(path.join(rootDir, "dist", "python-worker"));

  const items = [
    { from: path.join(distDir, "main.cjs"), to: path.join(electronDistDir, "main.cjs") },
    { from: path.join(distDir, "preload.cjs"), to: path.join(electronDistDir, "preload.cjs") },
    { from: path.join(distDir, "renderer"), to: path.join(electronDistDir, "renderer") },
  ];

  for (const { from, to } of items) {
    if (!fs.existsSync(from)) {
      throw new Error(`Missing build artifact: ${from}`);
    }
    copyRecursive(from, to);
    log("   ", `Copied: ${path.relative(rootDir, from)}`);
  }

  const pkg = {
    name: appName.toLowerCase(),
    version: require(path.join(rootDir, "package.json")).version,
    description: appName,
    main: "main.cjs",
  };
  fs.writeFileSync(
    path.join(electronDistDir, "package.json"),
    JSON.stringify(pkg, null, 2),
    "utf8",
  );

  if (fs.existsSync(pythonWorkerDir)) {
    copyRecursive(pythonWorkerDir, path.join(rootDir, "dist", "python-worker"));
    log("   ", "Python worker staged for extraResources");
  } else {
    log("   ", "WARNING: Python worker not built yet (will be bundled on next run)");
  }

  log("   ", `Staging complete: ${electronDistDir}`);
}

function stepBuildInstaller() {
  log("4/4", "Building portable EXE with electron-builder...");
  cleanDir(releaseDir);

  const cliPath = path.join(rootDir, "node_modules", "electron-builder", "cli.js");
  run("node", [cliPath, "--win", "portable"], { cwd: rootDir });

  const artifacts = fs.existsSync(releaseDir)
    ? fs.readdirSync(releaseDir).filter(f => !f.startsWith("builder-"))
    : [];
  if (artifacts.length === 0) {
    throw new Error("electron-builder did not produce any artifacts");
  }
  log("   ", `Release artifacts: ${artifacts.join(", ")}`);
}

function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  ${appName} - One-Click Desktop Packaging`);
  console.log(`${"=".repeat(50)}\n`);

  try {
    stepBuildElectron();
    stepBuildPythonWorker();
    stepStageAssets();
    stepBuildInstaller();

    console.log(`\n${"=".repeat(50)}`);
    console.log(`  Done! Your portable EXE is in:`);
    console.log(`  ${releaseDir}`);
    console.log(`${"=".repeat(50)}\n`);
  } catch (error) {
    console.error(`\n[package:electron] FAILED:`, error.message);
    process.exit(1);
  }
}

main();
