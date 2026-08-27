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
  log("   (Skipped - already built, remove dist/python-worker to force rebuild)");
  const workerBuildDir = path.join(rootDir, "dist", "python-worker");
  const exePath = path.join(workerBuildDir, "triagent-worker", "triagent-worker.exe");
  if (!fs.existsSync(exePath)) {
    run("node", [path.join(rootDir, "scripts", "build-python-worker.js")], { cwd: rootDir });
  }
}

function stepAssemblePackage() {
  log("3/4 Assembling desktop package...");

  const releaseDir = path.join(rootDir, "release");
  let winUnpackedDir = path.join(releaseDir, "win-unpacked");

  // Try to rename old release dir to bypass file locks
  if (fs.existsSync(releaseDir)) {
    const timestamp = Date.now();
    const oldDir = path.join(rootDir, `release_old_${timestamp}`);
    try {
      fs.renameSync(releaseDir, oldDir);
      log("   Renamed old release to " + path.basename(oldDir));
      try { fs.rmSync(oldDir, { recursive: true, force: false }); } catch { /* leave it */ }
    } catch {
      log("   WARNING: Cannot rename old release, using alternate output dir...");
      // Use a timestamped directory to avoid file locks
      winUnpackedDir = path.join(releaseDir, `win-unpacked-${timestamp}`);
    }
  }
  ensureDir(releaseDir);
  // Clean the target dir if it exists
  if (fs.existsSync(winUnpackedDir)) {
    try { fs.rmSync(winUnpackedDir, { recursive: true, force: true }); }
    catch { log("   WARNING: Cannot clean target dir, some files may be locked"); }
  }

  log("   Copying Electron runtime...");
  copyRecursive(electronDistDir, winUnpackedDir);

  // CRITICAL: Remove ALL .asar files from resources/
  // Electron prefers app.asar over app/ directory.
  // default_app.asar is Electron's built-in fallback that overrides our app.
  // Both MUST be removed for our app/ to load correctly.
  const resourcesDir = path.join(winUnpackedDir, "resources");
  for (const asarName of ["app.asar", "default_app.asar"]) {
    const asarPath = path.join(resourcesDir, asarName);
    if (fs.existsSync(asarPath)) {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          fs.rmSync(asarPath, { force: true });
          log(`   Removed ${asarName}`);
          break;
        } catch {
          if (attempt === 9) {
            log(`   WARNING: Cannot remove ${asarName} — app may not load correctly`);
            log(`   Try: close all TriAgent/Electron processes, then run the package script again`);
          }
        }
      }
    }
  }

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

function stepCreateZip(sourceDir) {
  log("4/4 Creating zip archive...");

  const releaseDir = path.join(rootDir, "release");
  const zipPath = path.join(releaseDir, `${appName}-${appVersion}-Win64.zip`);

  if (fs.existsSync(zipPath)) {
    try { fs.rmSync(zipPath, { force: true }); } catch { }
  }

  const zipCmd = `$ErrorActionPreference='SilentlyContinue'; Compress-Archive -Path "${sourceDir}\\*" -DestinationPath "${zipPath}" -Force`;
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
    const outputDir = stepAssemblePackage();
    stepCreateZip(outputDir);

    const releaseDir = path.join(rootDir, "release");
    const exeName = process.platform === "win32" ? "TriAgent.exe" : "TriAgent";
    const exePath = path.join(outputDir, exeName);
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
