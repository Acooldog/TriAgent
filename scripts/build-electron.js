const fs = require("node:fs");
const path = require("node:path");
const { build } = require("esbuild");

const rootDir = path.resolve(__dirname, "..");
const desktopDir = path.join(rootDir, "desktop");
const distDir = path.join(desktopDir, "dist");

async function main() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(distDir, "renderer"), { recursive: true });

  await Promise.all([
    build({ entryPoints: [path.join(desktopDir, "presentation", "main.ts")], bundle: true, platform: "node", format: "cjs", target: "node20", external: ["electron"], outfile: path.join(distDir, "main.cjs") }),
    build({ entryPoints: [path.join(desktopDir, "presentation", "preload.ts")], bundle: true, platform: "node", format: "cjs", target: "node20", external: ["electron"], outfile: path.join(distDir, "preload.cjs") }),
    build({ entryPoints: [path.join(desktopDir, "presentation", "renderer", "main.tsx")], bundle: true, platform: "browser", format: "iife", target: "es2022", outfile: path.join(distDir, "renderer", "renderer.js") }),
  ]);

  const rendererDir = path.join(desktopDir, "presentation", "renderer");
  const prototypeDir = path.join(rendererDir, "prototype");

  fs.copyFileSync(path.join(rendererDir, "index.html"), path.join(distDir, "renderer", "index.html"));

  const themeSrc = path.join(rendererDir, "theme");
  if (fs.existsSync(themeSrc)) {
    fs.cpSync(themeSrc, path.join(distDir, "renderer", "theme"), { recursive: true });
  }

  const stylesSrc = path.join(prototypeDir, "styles.css");
  if (fs.existsSync(stylesSrc)) {
    fs.copyFileSync(stylesSrc, path.join(distDir, "renderer", "styles.css"));
  }

  // Copy Python worker script so the packaged app can spawn it.
  const workerSrc = path.join(desktopDir, "infrastructure", "workers", "publicWorker.py");
  const workerDestDir = path.join(distDir, "desktop", "infrastructure", "workers");
  if (fs.existsSync(workerSrc)) {
    fs.mkdirSync(workerDestDir, { recursive: true });
    fs.copyFileSync(workerSrc, path.join(workerDestDir, "publicWorker.py"));
  }

  console.log(`Electron build ready: ${distDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
