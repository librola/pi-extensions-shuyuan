import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession, createCodemodeExtension, createEventBus, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { until } from "./helpers.ts";
import { rpc } from "./rpc-helpers.ts";

const entry = join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");

for (const useCodemode of [false, true]) {
  test(`真实 Pi SDK ${useCodemode ? "codemode 嵌套" : "直接"}调用：后台返回后空闲，完成消息启动新一轮`, { timeout: 15000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), "pi-background-bash-sdk-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const oldFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error("Network is forbidden in SDK tests"); };
    t.after(() => { globalThis.fetch = oldFetch; });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    let requests = 0;
    const prompts: string[] = [];
    const command = "sleep 0.4; printf sdk-done";
    runtime.registerProvider("test-only", {
      api: "openai-completions", apiKey: "not-a-real-key", baseUrl: "http://127.0.0.1:1",
      models: [{ id: "test-only", name: "Local test stub", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple: (model, context) => {
        requests++;
        prompts.push(JSON.stringify(context.messages));
        const stream = createAssistantMessageEventStream();
        const launch = requests === 1;
        const message: AssistantMessage = {
          role: "assistant", provider: model.provider, model: model.id, api: model.api,
          timestamp: Date.now(), stopReason: launch ? "toolUse" : "stop",
          content: launch ? [{ type: "toolCall", id: "launch-job", name: useCodemode ? "codemode" : "bash",
            arguments: useCodemode ? { code: `text(await tools.bash(${JSON.stringify({ command, background: true })}));` } : { command, background: true } }]
            : [{ type: "text", text: requests === 2 ? "Waiting for the completion notification." : "Handled sdk-done." }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: launch ? "toolUse" : "stop", message });
        });
        return stream;
      },
    });
    const events = createEventBus();
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager, eventBus: events, additionalExtensionPaths: [entry],
      extensionFactories: useCodemode ? [createCodemodeExtension()] : [],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const model = runtime.getModel("test-only", "test-only");
    assert.ok(model);
    const { session } = await createAgentSession({
      cwd: root, agentDir: root, resourceLoader: loader, settingsManager, modelRuntime: runtime, model,
      sessionManager: SessionManager.inMemory(root), tools: ["bash", "bash_jobs", ...(useCodemode ? ["codemode"] : [])], thinkingLevel: "off",
    });
    t.after(async () => {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    });
    const extensionErrors: unknown[] = [];
    await session.bindExtensions({
      mode: "rpc", uiContext: { setStatus: () => {}, notify: () => {} } as unknown as ExtensionUIContext,
      onError: error => extensionErrors.push(error),
    });
    assert.ok(session.getActiveToolNames().includes("bash"));
    await session.prompt("Start the background test.");
    assert.equal(requests, 2);
    assert.equal(session.isStreaming, false);
    const leaf = session.sessionManager.getLeafId();
    const entryCount = session.sessionManager.getEntries().length;
    const list = await rpc(events, "list");
    const id = list.data.jobs[0].id;
    assert.equal((await rpc(events, "status", { id })).success, true);
    assert.equal((await rpc(events, "output", { id })).success, true);
    assert.equal(session.sessionManager.getLeafId(), leaf, "只读查询不追加模型上下文或切换分支");
    assert.equal(session.sessionManager.getEntries().length, entryCount);
    assert.equal(requests, 2, "只读查询不触发模型请求");
    await until(() => requests === 3);
    await session.waitForIdle();
    assert.match(prompts[1]!, /job_id/);
    assert.match(prompts[1]!, /running/);
    assert.match(prompts[2]!, /sdk-done/);
    assert.equal(session.getLastAssistantText(), "Handled sdk-done.");
    const completion = session.messages.filter(message => message.role === "custom" && message.customType === "pi-background-bash:completion");
    assert.equal(completion.length, 1);
    const wake = session.messages.filter(message => message.role === "custom" && message.customType === "pi-background-bash:wakeup");
    assert.equal(wake.length, 1);
    const wakeMessage = wake[0]!;
    assert.ok(wakeMessage.role === "custom");
    assert.equal(wakeMessage.display, false, "直接和 codemode 调用的自动唤醒提示均隐藏，仍照常触发后续轮次");
    assert.deepEqual(extensionErrors, []);
    assert.equal(networkCalls, 0);
  });
}
