import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MVP_CAPABILITY_ID, MVP_PROVIDER_ID } from "../../infrastructure/providers/constants";
import { AuthorizedMvpProviderGateway } from "../../infrastructure/providers/gateways/authorizedMvpProviderGateway";
import { WorkerService } from "../../application/worker/workerService";
import { PythonWorkerClient } from "../../infrastructure/workers/pythonWorker";

test("私有 Provider 使用合法 KGM 样本完成真实解密并返回 MP3 产物", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trimusic-agent-provider-"));
  const outputDir = path.join(root, "output");
  const worker = new WorkerService(new PythonWorkerClient({
    workerScript: path.join(process.cwd(), "src", "Presentation", "worker.py"),
    cwd: process.cwd(),
    pythonExecutable: path.join(process.cwd(), ".venv", "Scripts", "python.exe"),
  }));
  const gateway = new AuthorizedMvpProviderGateway(worker);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  try {
    const result = await gateway.invoke({ requestId: "request-real", taskId: "task-real", providerId: MVP_PROVIDER_ID, capabilityId: MVP_CAPABILITY_ID, permissionMode: "standard", input: { platform: "kugou", inputPath: path.join(process.cwd(), "desktop", "tests", "fixtures", "sample.kgm"), outputDir, recursive: false }, timeoutMs: 30_000 }, (event) => events.push({ type: event.event_type, payload: event.payload }), new AbortController().signal);
    assert.deepEqual(events.slice(0, 2).map((event) => event.type), ["started", "progress"]);
    assert.equal(events.at(-1)?.type, "completed");
    assert.equal(events.at(-1)?.payload.engine, "primary");
    const output = result.output as { success: boolean; outputPath: string; format: string };
    assert.equal(output.success, true);
    assert.equal(output.format, "mp3");
    assert.equal((await fs.stat(output.outputPath)).size > 0, true);
    assert.equal(result.artifacts?.[0]?.kind, "audio");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
