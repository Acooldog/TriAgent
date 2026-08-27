import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.join(process.cwd(), "desktop", "presentation", "renderer", "prototype");
const jsDir = path.join(root, "js");

test("正式 Renderer 直接包含原型入口、脚本、样式和主题", async () => {
  const files = ["index.html", "js/app.js", "js/ui.js", "js/data.js", "styles.css", "js/llm-stream.js", path.join("theme", "tokens.css"), "js/agent-bridge.js"];
  for (const file of files) await fs.access(path.join(root, file));
  const index = await fs.readFile(path.join(root, "index.html"), "utf8");
  assert.match(index, /id="app"/);
  assert.match(index, /js\/app\.js/);
  assert.match(index, /tokens\.css/);
});

test("原型页面集合未被简化壳替换", async () => {
  const source = await fs.readFile(path.join(jsDir, "ui.js"), "utf8");
  for (const page of ["dashboard", "llm", "task", "library", "history", "diagnostics", "settings"]) assert.match(source, new RegExp(`state\\.page === [\\\"']${page}[\\\"']`));
  assert.match(source, /renderRecovery/);
  assert.match(source, /renderModal/);
  assert.match(source, /renderToast/);
});

test("原型任务入口已接入 Electron Agent bridge", async () => {
  const source = await fs.readFile(path.join(jsDir, "app.js"), "utf8");
  const adapter = await fs.readFile(path.join(jsDir, "runtime-adapter.js"), "utf8");
  const bridge = await fs.readFile(path.join(jsDir, "agent-bridge.js"), "utf8");
  assert.match(source, /triMusicPrototypeRuntime/);
  assert.match(adapter, /startTask/);
  assert.match(adapter, /cancelAgent/);
  assert.match(bridge, /startAgentTask/);
  assert.match(bridge, /onAgentEvent/);
});

test("模型设置暴露智谱所需配置并使用真实保存/测试入口", async () => {
  const ui = await fs.readFile(path.join(jsDir, "ui.js"), "utf8");
  const app = await fs.readFile(path.join(jsDir, "app.js"), "utf8");
  const handlers = await fs.readFile(path.join(jsDir, "actionHandlers.js"), "utf8");
  const bridge = await fs.readFile(path.join(jsDir, "agent-bridge.js"), "utf8");
  assert.match(ui, /data-input="model-name"/);
  assert.match(ui, /data-input="model-base-url"/);
  assert.match(app, /model-api-key/);
  assert.match(app, /model-thinking/);
  assert.match(app, /model-max-tokens/);
  assert.match(app, /model-temperature/);
  assert.match(handlers, /saveModelConfig/);
  assert.match(bridge, /startModel/);
});
