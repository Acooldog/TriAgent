import assert from "node:assert/strict";
import { test } from "node:test";
import { createRendererEventPublisher, type RendererEventTarget } from "../../presentation/ipc/rendererEventPublisher";

test("窗口在 IPC 注册后创建时仍向当前 Renderer 发布事件", () => {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  let target: RendererEventTarget | null = null;
  const publish = createRendererEventPublisher(() => target);

  assert.equal(publish("model:event", { requestId: "before-window" }), false);

  target = {
    webContents: {
      send: (channel: string, ...args: unknown[]) => { sent.push({ channel, payload: args[0] }); },
    },
  };

  const payload = { requestId: "request-1", event: { type: "text_delta", text: "你好" } };
  assert.equal(publish("model:event", payload), true);
  assert.deepEqual(sent, [{ channel: "model:event", payload }]);
});
