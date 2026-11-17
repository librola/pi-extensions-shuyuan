import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const entry = join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
for (const codemode of [false, true]) {
  test(`真实 SDK ${codemode ? "codemode" : "直接"} 请求使用当前文案，更新不改变工具选择`, { timeout: 15000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), "bash-copy-sdk-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("Network is forbidden in copy tests"); };
    t.after(() => { globalThis.fetch = oldFetch; });
    const base = { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" };
    let globalSettings = JSON.stringify({ ...base, backgroundBash: { autoBackground: true, defaultTimeoutSeconds: 60 } });
    const settingsManager = SettingsManager.fromStorage({ withLock: (scope, fn) => fn(scope === "global" ? globalSettings : undefined) });
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const requests: Array<{ text: string; tools: string[] }> = [];
    runtime.registerProvider("copy-test", {
      api: "openai-completions", apiKey: "not-a-real-key", baseUrl: "http://127.0.0.1:1",
      models: [{ id: "copy-test", name: "Local copy stub", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple: (model, context) => {
        requests.push({ text: JSON.stringify(context.messages), tools: getCurrentTools(context.messages).map(tool => tool.name) });
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason: "stop",
          content: [{ type: "text", text: "done" }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); });
        return stream;
      },
    });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, additionalExtensionPaths: [entry],
      extensionFactories: codemode ? [createCodemodeExtension()] : [], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader: loader, modelRuntime: runtime,
      model: runtime.getModel("copy-test", "copy-test")!, sessionManager: SessionManager.inMemory(root), tools: ["bash", "bash_jobs", ...(codemode ? ["codemode"] : [])] });
    t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "rpc", uiContext: { setStatus() {}, setWidget() {}, notify() {} } as unknown as ExtensionUIContext, onError: error => errors.push(error) });
    const info = () => session.getAllTools().find(tool => tool.name === "bash")!;
    assert.match(JSON.stringify(info().parameters), /default: 60s/);
    const selection = session.getActiveToolNames();
    await session.prompt("first");
    assert.match(requests[0]!.text, /default: 60s/);
    globalSettings = JSON.stringify({ ...base, backgroundBash: { autoBackground: false } }); await settingsManager.reload();
    await session.prompt("second");
    assert.match(info().description, /stay in the foreground/);
    assert.match(requests[1]!.text, /Execution timeout in seconds \(optional, no default timeout\)/);
    assert.deepEqual(session.getActiveToolNames(), selection);
    globalSettings = JSON.stringify({ ...base, backgroundBash: { autoBackground: true, defaultTimeoutSeconds: 15 } }); await settingsManager.reload();
    await session.prompt("third");
    assert.match(JSON.stringify(info().parameters), /default: 15s/);
    assert.match(requests[2]!.text, /default: 15s/);
    session.setActiveToolsByName(["bash_jobs"]);
    globalSettings = JSON.stringify({ ...base, backgroundBash: { autoBackground: false } }); await settingsManager.reload();
    await session.prompt("fourth");
    assert.deepEqual(session.getActiveToolNames(), ["bash_jobs"]);
    assert.deepEqual(requests[3]!.tools, ["bash_jobs"]);
    assert.deepEqual(errors, []);
  });
}
