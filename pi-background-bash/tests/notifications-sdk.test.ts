import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { until } from "./helpers.ts";
import { rpc } from "./rpc-helpers.ts";

const entry = join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");

for (const scenario of ["natural", "complete-before-stop", "complete-after-clear", "complete-after-stop"] as const) {
  test(`真实 SDK 完成记录和唤醒分离：${scenario}`, { timeout: 15000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), "pi-bash-notification-sdk-"));
    const oldFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error("SDK notification tests must stay offline"); };
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    let requests = 0;
    const prompts: string[] = [];
    runtime.registerProvider("notification-test", {
      api: "openai-completions", apiKey: "local-stub", baseUrl: "http://127.0.0.1:1",
      models: [{ id: "stub", name: "Offline notification test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple: (model, context) => {
        requests++; prompts.push(JSON.stringify(context.messages));
        const stream = createAssistantMessageEventStream();
        const command = requests === 1 ? "while [ ! -e bg-finish ]; do sleep 0.01; done; printf completion-token; exit 7"
          : "while [ ! -e fg-finish ]; do sleep 0.01; done; printf foreground-token";
        const tool = requests <= 2;
        const message: AssistantMessage = {
          role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop",
          content: tool ? [{ type: "toolCall", id: `call-${requests}`, name: "bash", arguments: { command, ...(requests === 1 ? { background: true } : { timeout: 10 }), hard_timeout: 10 } }]
            : [{ type: "text", text: requests === 3 ? "Other work finished." : "Handled completion-token." }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); });
        return stream;
      },
    });
    const events = createEventBus();
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, eventBus: events,
      additionalExtensionPaths: [entry], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const model = runtime.getModel("notification-test", "stub");
    assert.ok(model);
    const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader: loader, modelRuntime: runtime, model,
      sessionManager: SessionManager.create(root, join(root, "sessions")), tools: ["bash", "bash_jobs"], thinkingLevel: "off" });
    t.after(async () => {
      try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
      finally { globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true }); }
    });
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "rpc", uiContext: { setStatus: () => {}, notify: () => {} } as unknown as ExtensionUIContext, onError: error => errors.push(error) });
    const running = session.prompt("Run both test commands.");
    await until(async () => (await rpc(events, "list")).data.jobs.length === 2);
    const jobs = (await rpc(events, "list")).data.jobs;
    const id = jobs.find((job: { background: boolean }) => job.background).id;
    const finishBackground = async () => {
      writeFileSync(join(root, "bg-finish"), "");
      await until(async () => (await rpc(events, "status", { id })).data.job.status === "failed");
    };
    if (scenario === "complete-before-stop" || scenario === "natural") await finishBackground();
    if (scenario === "natural") {
      writeFileSync(join(root, "fg-finish"), "");
      await running;
      await session.waitForIdle();
      assert.equal(requests, 4, "忙碌时不打断前台工作，结束后只唤醒一次");
      assert.match(prompts[2]!, /completion-token/, "安全的 turn_end 已将完成事实加入后续上下文");
      assert.match(prompts[3]!, /completion-token/);
      assert.equal(session.getLastAssistantText(), "Handled completion-token.");
    } else {
      // 与 Pi Web Stop 的顺序一致；同时覆盖清队后恰好完成的竞争窗口。
      session.clearQueue();
      if (scenario === "complete-after-clear") await finishBackground();
      await session.abort(); await running; await session.waitForIdle();
      const stoppedRequests = requests;
      if (scenario === "complete-after-stop") await finishBackground();
      await until(() => session.messages.some(message => message.role === "custom" && message.customType === "pi-background-bash:completion"));
      await session.waitForIdle();
      assert.equal(requests, stoppedRequests, "Stop 后只记录结果，不自动重启模型");
      await session.prompt("Continue manually.");
      assert.equal(requests, stoppedRequests + 1, "下次用户输入不携带过期的自动唤醒");
    }
    const file = session.sessionManager.getSessionFile();
    assert.ok(file);
    const stored = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const completion = stored.filter(record => record.type === "custom_message" && record.customType === "pi-background-bash:completion");
    assert.equal(completion.length, 1, "完成记录只保存一次，并非仅存在于内存中");
    assert.equal(completion[0].display, true);
    assert.equal(completion[0].details.id, id);
    assert.equal(completion[0].details.status, "failed");
    assert.equal(completion[0].details.exit_code, 7);
    assert.match(completion[0].content, /completion-token/);
    const wake = stored.filter(record => record.type === "custom_message" && record.customType === "pi-background-bash:wakeup");
    assert.equal(wake.length, scenario === "natural" ? 1 : 0);
    if (wake.length) assert.equal(wake[0].display, false);
    assert.equal(stored.filter(record => record.type === "message" && record.message?.role === "user").length, scenario === "natural" ? 1 : 2, "不伪造用户消息");
    assert.deepEqual(errors, []);
    assert.equal(networkCalls, 0);
  });
}
