const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const electronDistDir = path.join(rootDir, "node_modules", "electron", "dist");
const electronPkg = require("electron/package.json");
const appVersion = require(path.join(rootDir, "package.json")).version;

const appName = "TriAgent";
const exeName = "TriAgent";

function log(msg) {
  console.log(`[package:electron] ${msg}`);
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
  log("1/4 Building Electron frontend...");
  run("node", [path.join(rootDir, "scripts", "build-electron.js")], { cwd: rootDir });
}

function stepBuildPythonWorker() {
  log("2/4 Building Python worker (standalone exe)...");
  run("node", [path.join(rootDir, "scripts", "build-python-worker.js")], { cwd: rootDir });
}

function stepAssemblePackage() {
  log("3/4 Assembling desktop package...");

  const winUnpackedDir = path.join(rootDir, "release", "win-unpacked");

  const releaseDir = path.join(rootDir, "release");
  if (fs.existsSync(releaseDir)) {
    const timestamp = Date.now();
    const oldDir = path.join(rootDir, `release_old_${timestamp}`);
    try {
      fs.renameSync(releaseDir, oldDir);
      log("   Renamed old release to " + path.basename(oldDir));
    } catch {
      log("   WARNING: Cannot rename old release, will try to clean...");
    }
  }
  ensureDir(releaseDir);

  log("   Copying Electron runtime...");
  copyRecursive(electronDistDir, winUnpackedDir);

  const electronExe = process.platform === "win32" ? "electron.exe" : "electron";
  const appExe = process.platform === "win32" ? `${exeName}.exe` : exeName;
  const electronExePath = path.join(winUnpackedDir, electronExe);
  const appExePath = path.join(winUnpackedDir, appExe);

  if (electronExePath !== appExePath) {
    fs.renameSync(electronExePath, appExePath);
  }

  const appDir = path.join(winUnpackedDir, "resources", "app");
  ensureDir(appDir);

  const electronBuildDir = path.join(rootDir, "dist", "electron");
  const items = ["main.cjs", "preload.cjs", "renderer"];
  for (const item of items) {
    const src = path.join(electronBuildDir, item);
    const dst = path.join(appDir, item);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing build artifact: ${src}`);
    }
    copyRecursive(src, dst);
    log(`   Copied: ${item}`);
  }

  const pkg = {
    name: appName.toLowerCase(),
    version: appVersion,
    description: appName,
    main: "main.cjs",
  };
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify(pkg, null, 2),
    "utf8",
  );

  const workerBuildDir = path.join(rootDir, "dist", "python-worker");
  const workerDestDir = path.join(winUnpackedDir, "resources", "python-worker");
  ensureDir(workerDestDir);
  if (fs.existsSync(workerBuildDir)) {
    copyRecursive(workerBuildDir, workerDestDir);
    log("   Copied: python-worker");
  } else {
    log("   WARNING: python-worker not built yet");
  }

  log(`   Assembled: ${winUnpackedDir}`);
  return winUnpackedDir;
}

function stepCreateZip() {
  log("4/4 Creating zip archive...");

  const releaseDir = path.join(rootDir, "release");
  const winUnpackedDir = path.join(releaseDir, "win-unpacked");
  const zipPath = path.join(releaseDir, `${appName}-${appVersion}-Win64.zip`);

  if (fs.existsSync(zipPath)) {
    try { fs.rmSync(zipPath, { force: true }); } catch { }
  }

  const exeName = process.platform === "win32" ? "TriAgent.exe" : "TriAgent";
  const zipCmd = `$ErrorActionPreference='SilentlyContinue'; Compress-Archive -Path "${winUnpackedDir}\\*" -DestinationPath "${zipPath}" -Force`;
  const result = spawnSync("powershell", [
    "-ExecutionPolicy", "Bypass", "-Command", zipCmd
  ], { cwd: rootDir, timeout: 300000, stdio: "pipe" });

  if (!fs.existsSync(zipPath)) {
    throw new Error("Failed to create zip archive");
  }

  const sizeMB = Math.round(fs.statSync(zipPath).size / 1024 / 1024);
  log(`   ZIP ready: ${path.basename(zipPath)} (${sizeMB} MB)`);
}

function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  ${appName} - Desktop Packaging`);
  console.log(`  Electron ${electronPkg.version}`);
  console.log(`${"=".repeat(50)}\n`);

  try {
    stepBuildElectron();
    stepBuildPythonWorker();
    stepAssemblePackage();
    stepCreateZip();

    const releaseDir = path.join(rootDir, "release");
    const exePath = path.join(releaseDir, "win-unpacked", `${exeName}.exe`);
    const zipPath = path.join(releaseDir, `${appName}-${appVersion}-Win64.zip`);

    console.log(`\n${"=".repeat(50)}`);
    console.log(`  Done!`);
    console.log(`\n  Run directly:`);
    console.log(`    ${exePath}`);
    console.log(`\n  Or distribute the zip:`);
    console.log(`    ${zipPath}`);
    console.log(`${"=".repeat(50)}\n`);
  } catch (error) {
    console.error(`\n[package:electron] FAILED:`, error.message);
    process.exit(1);
  }
}

main();
