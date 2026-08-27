const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  capture,
  cleanDir,
  commandSucceeds,
  ensureDir,
  ensureEmptyDir,
  ensureFile,
  fail,
  locateIscc,
  run,
} = require("./build-lib");

const rootDir = path.resolve(__dirname, "..");
const desktopDir = path.join(rootDir, "desktop");
const distDir = path.join(desktopDir, "dist");
const releaseDir = path.join(rootDir, "release");
const buildDir = path.join(rootDir, "build");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));

const appName = "TriAgent";
const exeName = "TriAgent";
const appId = "com.triagent.app";
const appVersion = packageJson.version;
const appIcon = path.join(rootDir, "封面", "封面.ico");
const pythonExe = resolvePythonExe();

const electronVersion = "37.0.0";

function resolvePythonExe() {
  if (process.env.TRIAGENT_PYTHON) {
    const p = process.env.TRIAGENT_PYTHON.trim();
    if (fs.existsSync(p)) return p;
  }
  const candidates = [
    path.join(rootDir, ".venv", "Scripts", "python.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "python";
}

function ensureElectronBuilt() {
  if (!fs.existsSync(path.join(distDir, "main.cjs"))) {
    console.log("[package] Electron dist not found, running build-electron.js...");
    run("node", [path.join(rootDir, "scripts", "build-electron.js")], { cwd: rootDir });
  }
  ensureFile(path.join(distDir, "main.cjs"), "electron main bundle");
  ensureFile(path.join(distDir, "preload.cjs"), "electron preload bundle");
  ensureFile(path.join(distDir, "renderer", "renderer.js"), "electron renderer bundle");
  ensureFile(path.join(distDir, "renderer", "index.html"), "renderer index.html");
}

function copyWorkerPython() {
  const workerSrc = path.join(rootDir, "src", "Presentation", "worker", "worker.py");
  const workerDestDir = path.join(distDir, "python-worker", "src", "Presentation", "worker");
  fs.mkdirSync(workerDestDir, { recursive: true });
  if (fs.existsSync(workerSrc)) {
    fs.copyFileSync(workerSrc, path.join(workerDestDir, "worker.py"));
  }
  const runtimeSrc = path.join(rootDir, "src", "Presentation", "worker", "worker_runtime.py");
  if (fs.existsSync(runtimeSrc)) {
    fs.copyFileSync(runtimeSrc, path.join(workerDestDir, "worker_runtime.py"));
  }
  const pythonWorkerSrc = path.join(desktopDir, "infrastructure", "workers", "publicWorker.py");
  const pythonWorkerDest = path.join(distDir, "python-worker", "publicWorker.py");
  if (fs.existsSync(pythonWorkerSrc)) {
    fs.copyFileSync(pythonWorkerSrc, pythonWorkerDest);
  }
  const srcRoot = path.join(distDir, "python-worker", "src");
  if (fs.existsSync(srcRoot)) {
    const adaptersSrc = path.join(rootDir, "src", "Infrastructure", "adapters");
    const adaptersDest = path.join(srcRoot, "Infrastructure", "adapters");
    if (fs.existsSync(adaptersSrc)) {
      copyRecursive(adaptersSrc, adaptersDest);
    }
  }
  const assetsSrc = path.join(rootDir, "assets");
  const assetsDest = path.join(distDir, "python-worker", "assets");
  if (fs.existsSync(assetsSrc)) {
    copyRecursive(assetsSrc, assetsDest);
  }
}

function copyRecursive(sourceDir, targetDir) {
  if (fs.statSync(sourceDir).isFile()) {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.copyFileSync(sourceDir, targetDir);
    return;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(src, dst);
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
}

function createPackageJsonForBundle() {
  const pkg = {
    name: appName.toLowerCase(),
    version: appVersion,
    description: appName,
    main: "main.cjs",
  };
  fs.writeFileSync(
    path.join(distDir, "package.json"),
    JSON.stringify(pkg, null, 2),
    "utf8",
  );
}

function packageElectronFolder() {
  const electronPkg = require("electron/package.json");
  const electronVersion = electronPkg.version;

  const outDir = path.join(buildDir, "electron-pack");
  ensureEmptyDir(outDir);

  const platform = process.platform === "win32" ? "win32" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;

  const electronDist = path.join(
    rootDir,
    "node_modules",
    "electron",
    "dist",
  );

  const electronExe = platform === "win32"
    ? path.join(electronDist, "electron.exe")
    : path.join(electronDist, "electron");

  ensureFile(electronExe, "electron binary");

  const bundleName = `${appName}-${platform}-${arch}`;
  const bundleDir = path.join(outDir, bundleName);
  fs.mkdirSync(bundleDir, { recursive: true });

  const copyItems = [
    { src: electronDist, dest: bundleDir, pattern: null },
  ];

  copyItems.forEach(({ src, dest, pattern }) => {
    if (pattern) {
      run("robocopy", [src, dest, pattern, "/E", "/NFL", "/NDL"], { shell: true });
    } else {
      copyRecursive(src, dest);
    }
  });

  fs.renameSync(
    path.join(bundleDir, `electron${platform === "win32" ? ".exe" : ""}`),
    path.join(bundleDir, `${exeName}${platform === "win32" ? ".exe" : ""}`),
  );

  const appDir = path.join(bundleDir, "resources", "app");
  fs.mkdirSync(appDir, { recursive: true });

  const itemsToCopy = [
    ["main.cjs", path.join(distDir, "main.cjs"), path.join(appDir, "main.cjs")],
    ["preload.cjs", path.join(distDir, "preload.cjs"), path.join(appDir, "preload.cjs")],
    ["renderer/", path.join(distDir, "renderer"), path.join(appDir, "renderer")],
    ["package.json", path.join(distDir, "package.json"), path.join(appDir, "package.json")],
    ["python-worker/", path.join(distDir, "python-worker"), path.join(appDir, "python-worker")],
  ];

  for (const [label, src, dst] of itemsToCopy) {
    if (!fs.existsSync(src)) {
      console.warn(`[package] Skipping missing: ${label}`);
      continue;
    }
    const stat = fs.statSync(src);
    if (stat.isFile()) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } else {
      copyRecursive(src, dst);
    }
    console.log(`[package] Copied: ${label}`);
  }

  const finalBundle = path.join(releaseDir, bundleName);
  ensureEmptyDir(finalBundle);
  copyRecursive(bundleDir, finalBundle);

  return finalBundle;
}

function createZipArchive(sourceDir, zipPath) {
  const command = process.platform === "win32" ? "powershell" : "zip";
  if (process.platform === "win32") {
    const script = `
      Compress-Archive -Path "${sourceDir}\\*" -DestinationPath "${zipPath}" -Force
    `.trim();
    run("powershell", ["-ExecutionPolicy", "Bypass", "-Command", script], {
      cwd: rootDir,
    });
  } else {
    run("zip", ["-r", zipPath, "."], { cwd: sourceDir });
  }
}

function createInstaller(bundleDir) {
  const isccExe = locateIscc();
  if (!isccExe) {
    console.warn("[package] ISCC not found, skipping installer creation.");
    return null;
  }
  ensureFile(appIcon, "app icon");

  const setupName = `${appName}-Setup-${appVersion}`;
  const scriptPath = path.join(buildDir, "electron-installer.iss");
  const iss = `
[Setup]
AppId={{12345678-1234-1234-1234-123456789ABC}
AppName=${appName}
AppVersion=${appVersion}
AppPublisher=TriAgent
DefaultDirName={autopf}\\${appName}
DefaultGroupName=${appName}
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=${releaseDir.replace(/\\\\/g, "\\\\\\\\")}
OutputBaseFilename=${setupName}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
SetupIconFile=${appIcon.replace(/\\\\/g, "\\\\\\\\")}
UninstallDisplayIcon={app}\\${exeName}.exe

[Files]
Source: "${bundleDir.replace(/\\\\/g, "\\\\\\\\")}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\\${appName}"; Filename: "{app}\\${exeName}.exe"; IconFilename: "{app}\\${exeName}.exe"
Name: "{autodesktop}\\${appName}"; Filename: "{app}\\${exeName}.exe"; Tasks: desktopicon; IconFilename: "{app}\\${exeName}.exe"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional tasks:"

[Run]
Filename: "{app}\\${exeName}.exe"; Description: "Launch ${appName}"; Flags: nowait postinstall skipifsilent
`.trim();

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, iss, "utf8");

  run(isccExe, [scriptPath], { cwd: rootDir });

  const setupPath = path.join(releaseDir, `${setupName}.exe`);
  ensureFile(setupPath, "electron installer");
  return setupPath;
}

function main() {
  ensureEmptyDir(releaseDir);
  fs.mkdirSync(buildDir, { recursive: true });

  console.log(`[package] Building ${appName} v${appVersion}...`);

  ensureElectronBuilt();
  copyWorkerPython();
  createPackageJsonForBundle();

  console.log("[package] Packaging Electron bundle...");
  const bundleDir = packageElectronFolder();
  console.log(`[package] Bundle ready: ${bundleDir}`);

  if (process.platform === "win32") {
    console.log("[package] Creating Inno Setup installer...");
    const installer = createInstaller(bundleDir);
    if (installer) {
      console.log(`[package] Installer ready: ${installer}`);
    }
  }

  const assets = fs.readdirSync(releaseDir).sort();
  console.log(`[package] Release assets: ${assets.join(", ")}`);
  console.log("[package] Done.");
}

main();
