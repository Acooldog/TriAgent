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
    build({ entryPoints: [path.join(desktopDir, "presentation", "renderer", "main.tsx")], bundle: true, platform: "browser", format: "iife", target: "es2022", outfile: path.join(distDir, "renderer.js") }),
  ]);
  fs.copyFileSync(path.join(desktopDir, "presentation", "renderer", "index.html"), path.join(distDir, "renderer", "index.html"));
  const prototypeDir = path.join(desktopDir, "presentation", "renderer", "prototype");
  if (fs.existsSync(prototypeDir)) {
    fs.cpSync(prototypeDir, path.join(distDir, "renderer"), { recursive: true });
  }
  console.log(`Electron build ready: ${distDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
