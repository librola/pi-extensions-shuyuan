import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession, createCodemodeExtension, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { until } from "./helpers.ts";
import { rpc } from "./rpc-helpers.ts";

const entry = join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");

for (const useCodemode of [false, true]) {
  for (const scenario of ["natural", "complete-during-final-response", "mixed", "filtered", "complete-before-stop", "complete-after-clear", "complete-after-stop"] as const) {
    test(`真实 SDK ${useCodemode ? "codemode 嵌套" : "直接"}调用的完成记录和唤醒：${scenario}`, { timeout: 15000 }, async t => {
      const root = mkdtempSync(join(tmpdir(), "pi-bash-notification-sdk-"));
      const oldFetch = globalThis.fetch;
      let networkCalls = 0;
      let session: AgentSession | undefined;
      globalThis.fetch = async () => { networkCalls++; throw new Error("SDK notification tests must stay offline"); };
      t.after(async () => {
        try {
          if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
        } finally { globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true }); }
      });
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
      const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
      let requests = 0;
      let finishFinalResponse: (() => void) | undefined;
      const prompts: string[] = [];
      runtime.registerProvider("notification-test", {
        api: "openai-completions", apiKey: "local-stub", baseUrl: "http://127.0.0.1:1",
        models: [{ id: "stub", name: "Offline notification test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple: (model, context) => {
          requests++; prompts.push(JSON.stringify(context.messages));
          const stream = createAssistantMessageEventStream();
          const background = "while [ ! -e bg-finish ]; do sleep 0.01; done; printf completion-token; exit 7";
          const second = "while [ ! -e bg-second-finish ]; do sleep 0.01; done; printf second-completion-token; exit 7";
          const foreground = "while [ ! -e fg-finish ]; do sleep 0.01; done; printf foreground-token";
          const commands = requests === 1 ? [background, ...(scenario === "mixed" ? [second] : [])] : [foreground];
          const args = commands.map(command => ({ command, ...(requests === 1 ? { background: true } : { timeout: 10 }), hard_timeout: 10 }));
          const tool = requests <= 2;
          const message: AssistantMessage = {
            role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop",
            content: tool ? (useCodemode
              ? [{ type: "toolCall", id: `call-${requests}`, name: "codemode", arguments: { code: args.map(arg => `text(await tools.bash(${JSON.stringify(arg)}));`).join("\n") } }]
              : args.map((arg, index) => ({ type: "toolCall" as const, id: `call-${requests}-${index}`, name: "bash", arguments: arg })))
              : [{ type: "text", text: requests === 3 && scenario !== "natural" ? "Other work finished." : "Handled completion-token." }],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          const gated = requests === 3 && (scenario === "complete-during-final-response" || scenario === "mixed");
          queueMicrotask(() => {
            stream.push({ type: "start", partial: message });
            const finish = () => stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
            if (gated) finishFinalResponse = finish;
            else finish();
          });
          return stream;
        },
      });
      const events = createEventBus();
      const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, eventBus: events,
        additionalExtensionPaths: [entry],
        extensionFactories: [
          ...(useCodemode ? [createCodemodeExtension()] : []),
          pi => {
            if (scenario === "filtered") pi.on("context", event => {
              if (requests === 2) return { messages: event.messages.filter(message => message.role !== "custom" || message.customType !== "pi-background-bash:completion") };
            });
          },
        ],
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const model = runtime.getModel("notification-test", "stub");
      assert.ok(model);
      ({ session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader: loader, modelRuntime: runtime, model,
        sessionManager: SessionManager.create(root, join(root, "sessions")), tools: ["bash", "bash_jobs", ...(useCodemode ? ["codemode"] : [])], thinkingLevel: "off" }));
      const errors: unknown[] = [];
      await session.bindExtensions({ mode: "rpc", uiContext: { setStatus: () => {}, notify: () => {} } as unknown as ExtensionUIContext, onError: error => errors.push(error) });
      const running = session.prompt("Run both test commands.");
      await until(async () => (await rpc(events, "list")).data.jobs.length === (scenario === "mixed" ? 3 : 2));
      const jobs = (await rpc(events, "list")).data.jobs;
      const id = jobs.find((job: { command: string }) => job.command.includes("bg-finish")).id;
      const secondId = jobs.find((job: { command: string }) => job.command.includes("bg-second-finish"))?.id;
      const finishBackground = async (jobId = id, marker = "bg-finish") => {
        writeFileSync(join(root, marker), "");
        await until(async () => (await rpc(events, "status", { id: jobId })).data.job.status === "failed");
      };
      const stopped = scenario === "complete-before-stop" || scenario === "complete-after-clear" || scenario === "complete-after-stop";
      if (scenario === "natural" || scenario === "filtered" || scenario === "mixed" || scenario === "complete-before-stop") await finishBackground();
      const header = `Background bash ${id}: failed (exit 7).`;
      if (!stopped) {
        writeFileSync(join(root, "fg-finish"), "");
        if (scenario === "complete-during-final-response" || scenario === "mixed") {
          await until(() => requests === 3 && finishFinalResponse !== undefined);
          assert.equal(prompts[2]!.includes(header), scenario === "mixed", "只以请求实际携带的完成记录判断，不用命令参数中的输出标记冒充结果");
          if (scenario === "mixed") {
            assert.ok(secondId);
            await finishBackground(secondId, "bg-second-finish");
            assert.ok(!prompts[2]!.includes(`Background bash ${secondId}: failed (exit 7).`));
          } else await finishBackground();
          finishFinalResponse!();
        }
        await running;
        await session.waitForIdle();
        assert.equal(requests, scenario === "natural" ? 3 : 4, "已读结果不额外唤醒，尚未读到的结果只唤醒一次");
        assert.equal(prompts[2]!.includes(header), scenario === "natural" || scenario === "mixed");
        if (scenario !== "natural") assert.ok(prompts[3]!.includes(header));
        assert.equal(session.getLastAssistantText(), "Handled completion-token.");
      } else {
        // 与 Pi Web Stop 的顺序一致；同时覆盖清队后恰好完成的竞争窗口。
        session.clearQueue();
        if (scenario === "complete-after-clear") await finishBackground();
        await session.abort(); await running; await session.waitForIdle();
        const stoppedRequests = requests;
        if (scenario === "complete-after-stop") await finishBackground();
        await until(() => session!.messages.some(message => message.role === "custom" && message.customType === "pi-background-bash:completion"));
        await session.waitForIdle();
        assert.equal(requests, stoppedRequests, "Stop 后只记录结果，不自动重启模型");
        await session.prompt("Continue manually.");
        assert.equal(requests, stoppedRequests + 1, "下次用户输入不携带过期的自动唤醒");
      }
      const file = session.sessionManager.getSessionFile();
      assert.ok(file);
      const stored = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const completion = stored.filter(record => record.type === "custom_message" && record.customType === "pi-background-bash:completion");
      assert.equal(completion.length, scenario === "mixed" ? 2 : 1, "每个完成记录只保存一次，并非仅存在于内存中");
      for (const record of completion) {
        assert.equal(record.display, true);
        assert.equal(record.details.status, "failed");
        assert.equal(record.details.exit_code, 7);
        assert.match(record.content, /completion-token/);
      }
      assert.deepEqual(new Set(completion.map(record => record.details.id)), new Set([id, ...(secondId ? [secondId] : [])]));
      const wake = stored.filter(record => record.type === "custom_message" && record.customType === "pi-background-bash:wakeup");
      assert.equal(wake.length, stopped || scenario === "natural" ? 0 : 1);
      if (wake.length) {
        assert.equal(wake[0].display, false);
        assert.deepEqual(wake[0].details.jobIds, [scenario === "mixed" ? secondId : id], "批量唤醒只包含尚未被模型读到的任务");
      }
      assert.equal(stored.filter(record => record.type === "message" && record.message?.role === "user").length, stopped ? 2 : 1, "不伪造用户消息");
      assert.deepEqual(errors, []);
      assert.equal(networkCalls, 0);
    });
  }
}
