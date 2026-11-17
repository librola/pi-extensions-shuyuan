import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createBashToolDefinition, SettingsManager } from "@earendil-works/pi-coding-agent";
import { harness, until } from "./helpers.ts";

function object(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}

test("Bash 文案按当前默认生成，数值只放 timeout 参数，工厂不读取未绑定的设置", async t => {
  let settingsReads = 0;
  const h = harness({ get settings() { settingsReads++; return {}; } });
  t.after(() => h.close());
  assert.equal(settingsReads, 0);
  assert.ok(h.tools.get("bash")!.description.startsWith("Execute a bash command in the current working directory."));
  await h.emit("session_start");
  const bash = h.tools.get("bash")!;
  assert.match(bash.description, /commands that exceed timeout continue in the background/);
  assert.doesNotMatch(bash.description, /180|TUI|RPC|backgroundBash/);
  assert.match(object(bash.parameters).properties.timeout.description, /default: 180s/);
  assert.doesNotMatch(object(bash.parameters).properties.timeout.description, /disabled|print|JSON/);
});

test("文案跟随有效设置变更，关闭状态不解释自动后台，恢复后显示新默认", async t => {
  const settings = { backgroundBash: { autoBackground: true, defaultTimeoutSeconds: 60 } };
  const h = harness({ settings });
  t.after(() => h.close());
  await h.emit("session_start");
  const first = h.tools.get("bash")!;
  assert.match(object(first.parameters).properties.timeout.description, /default: 60s/);
  await h.emit("before_agent_start", h.ctx, { systemPromptOptions: { toolGuidelines: { bash: first.promptGuidelines } } });
  assert.equal(h.tools.get("bash"), first, "配置没变时不重复注册工具");
  settings.backgroundBash.autoBackground = false;
  await h.emit("before_agent_start", h.ctx, { systemPromptOptions: { toolGuidelines: { bash: first.promptGuidelines } } });
  const disabled = h.tools.get("bash")!;
  assert.match(disabled.description, /stay in the foreground/);
  assert.doesNotMatch(disabled.description, /commands that exceed timeout|default:|60s|180s/);
  assert.match(object(disabled.parameters).properties.timeout.description, /Execution timeout.*no default timeout/);
  assert.doesNotMatch(object(disabled.parameters).properties.timeout.description, /background|Unused|print|JSON/);
  assert.match(object(disabled.parameters).properties.background.description, /immediately/);
  settings.backgroundBash.autoBackground = true;
  settings.backgroundBash.defaultTimeoutSeconds = 0.5;
  await h.emit("before_agent_start", h.ctx, { systemPromptOptions: { toolGuidelines: { bash: disabled.promptGuidelines } } });
  assert.match(object(h.tools.get("bash")!.parameters).properties.timeout.description, /default: 0\.5s/);
});

test("首轮刷新同步自己的提示词规则，保留其他扩展规则和已选择工具", async t => {
  const h = harness();
  t.after(() => h.close());
  const previous = h.tools.get("bash")!.promptGuidelines!;
  const options = { toolGuidelines: { bash: [...previous, "Keep another extension's rule."] }, selectedTools: ["bash_jobs"] };
  await h.emit("before_agent_start", h.ctx, { systemPromptOptions: options });
  assert.deepEqual(options.toolGuidelines.bash, [...h.tools.get("bash")!.promptGuidelines!, "Keep another extension's rule."]);
  assert.deepEqual(options.selectedTools, ["bash_jobs"]);
  assert.equal(h.messages.length, 0);
  assert.equal(h.widgets.size, 0);
});

test("关闭状态忽略无关非法默认等待值，非法状态的文案不冒充正常默认", async t => {
  const h = harness({ settings: { backgroundBash: { autoBackground: false, defaultTimeoutSeconds: "invalid" } } });
  t.after(() => h.close());
  await h.emit("session_start");
  assert.match(object(h.tools.get("bash")!.parameters).properties.timeout.description, /no default timeout/);
  assert.equal(object((await h.call("bash", { command: "printf works" })).structuredContent).output, "works");
  const invalid = harness({ settings: { backgroundBash: { defaultTimeoutSeconds: 0 } } });
  t.after(() => invalid.close());
  await invalid.emit("session_start");
  assert.match(invalid.tools.get("bash")!.description, /configured default wait is invalid/);
  assert.doesNotMatch(object(invalid.tools.get("bash")!.parameters).properties.timeout.description, /default: 180s/);
});

test("前台成功和非零退出保持 Pi 原生 structuredContent 与错误标记", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  for (const command of ["printf hello", "printf failure; exit 7"]) {
    const expected = await createBashToolDefinition(h.cwd).execute("native", { command }, undefined, undefined, h.ctx);
    const actual = await h.call("bash", { command });
    assert.deepEqual(actual.content, expected.content);
    const expectedData = object(expected.structuredContent);
    const actualData = object(actual.structuredContent);
    delete expectedData.wall_time_seconds;
    delete actualData.wall_time_seconds;
    assert.deepEqual(actualData, expectedData);
    assert.equal(actual.isError, expected.isError);
  }
  assert.equal(h.messages.length, 0);
});

test("默认等待读取 Pi 的有效设置，项目配置覆盖全局，显式参数再覆盖配置", async t => {
  const storage = { withLock: (scope: "global" | "project", read: (current: string | undefined) => string | undefined) => {
    read(JSON.stringify({ backgroundBash: { defaultTimeoutSeconds: scope === "global" ? 0.02 : 0.03 } }));
  } };
  const global = SettingsManager.fromStorage(storage, { projectTrusted: false }).getSettings();
  assert.equal(Reflect.get(global, "backgroundBash").defaultTimeoutSeconds, 0.02);
  const settings = SettingsManager.fromStorage(storage, { projectTrusted: true }).getSettings();
  assert.equal(Reflect.get(settings, "backgroundBash").defaultTimeoutSeconds, 0.03);
  const h = harness({ settings: { ...settings } });
  t.after(() => h.close());
  await h.emit("session_start");
  for (const timeout of [undefined, 0.04]) {
    const result = await h.call("bash", { command: "sleep 5", ...(timeout === undefined ? {} : { timeout }) });
    const expected = timeout ?? 0.03;
    assert.ok(result.content[0]!.type === "text" && result.content[0].text.includes(`Foreground wait timed out after ${expected}s.`));
    assert.equal(object(result.structuredContent).status, "running");
    await h.call("bash_jobs", { action: "stop", id: object(result.structuredContent).job_id });
  }
});

test("有效配置可关闭自动移交，显式后台仍可用，非法开关不启动命令", async t => {
  const settings = { backgroundBash: { autoBackground: false as unknown, defaultTimeoutSeconds: 0.001 } };
  const h = harness({ settings });
  t.after(() => h.close());
  await h.emit("session_start");
  await assert.rejects(h.call("bash", { command: "sleep 0.15; printf should-not-run", timeout: 0.03 }), /Command timed out after 0\.03 seconds/);
  assert.equal(h.messages.length, 0);
  const stopped = object((await h.call("bash_jobs", { action: "list" })).structuredContent).jobs[0];
  assert.equal(stopped.status, "timed_out");
  assert.equal(stopped.hard_timeout, 0.03);
  const noLimit = await h.call("bash", { command: "sleep 0.04; printf foreground" });
  assert.equal(object(noLimit.structuredContent).output, "foreground");
  settings.backgroundBash.autoBackground = "false";
  const count = object((await h.call("bash_jobs", { action: "list" })).structuredContent).jobs.length;
  await assert.rejects(h.call("bash", { command: "printf must-not-run", timeout: 0.01 }), /backgroundBash\.autoBackground/);
  assert.equal(object((await h.call("bash_jobs", { action: "list" })).structuredContent).jobs.length, count);
  const background = await h.call("bash", { command: "sleep 5", background: true });
  assert.equal(object(background.structuredContent).status, "running");
  await h.call("bash_jobs", { action: "stop", id: object(background.structuredContent).job_id });
});

test("运行中的命令保持原时限，刷新文案不终止或重跑旧命令", async t => {
  const settings = { backgroundBash: { autoBackground: true } };
  const h = harness({ settings });
  t.after(() => h.close());
  await h.emit("session_start"); h.ctx.isIdle = () => false;
  const pending = h.call("bash", { command: "sleep 5", timeout: 0.03 });
  settings.backgroundBash.autoBackground = false;
  await h.emit("before_agent_start", h.ctx, { systemPromptOptions: { toolGuidelines: { bash: h.tools.get("bash")!.promptGuidelines } } });
  const result = await pending;
  const id = object(result.structuredContent).job_id;
  const job = object((await h.call("bash_jobs", { action: "status", id })).structuredContent).job;
  assert.equal(job.status, "running");
  assert.equal(job.hard_timeout, undefined);
  assert.match(h.tools.get("bash")!.description, /stay in the foreground/);
  await h.call("bash_jobs", { action: "stop", id });
});

test("关闭自动移交时，主动后台的 timeout 仍限制执行，hard_timeout 优先", async t => {
  const h = harness({ settings: { backgroundBash: { autoBackground: false } } });
  t.after(() => h.close());
  await h.emit("session_start"); h.ctx.isIdle = () => false;
  const result = await h.call("bash", { command: "printf begin; sleep 5", background: true, timeout: 0.05 });
  const id = object(result.structuredContent).job_id;
  await until(() => h.messages.length === 1);
  assert.equal(h.messages[0]!.message.details.status, "timed_out");
  assert.equal(h.messages[0]!.message.details.hard_timeout, 0.05);
  assert.equal(object((await h.call("bash_jobs", { action: "status", id })).structuredContent).job.status, "timed_out");
  const precedence = await h.call("bash", { command: "sleep 0.04; printf precedence", timeout: 0.001, hard_timeout: 1 });
  assert.equal(object(precedence.structuredContent).output, "precedence");
});

test("非法默认配置不启动命令，主动后台与显式等待不依赖默认配置", async t => {
  const h = harness({ settings: { backgroundBash: { defaultTimeoutSeconds: 0 } } });
  t.after(() => h.close());
  await h.emit("session_start");
  await assert.rejects(h.call("bash", { command: "printf must-not-run" }), /backgroundBash\.defaultTimeoutSeconds/);
  assert.deepEqual(object((await h.call("bash_jobs", { action: "list" })).structuredContent).jobs, []);
  for (const options of [{ background: true }, { timeout: 0.02 }]) {
    const result = await h.call("bash", { command: "sleep 5", ...options });
    assert.equal(object(result.structuredContent).status, "running");
    await h.call("bash_jobs", { action: "stop", id: object(result.structuredContent).job_id });
  }
});

test("主动后台返回 job_id，可见完成事实与隐藏的模型唤醒分离", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  const result = await h.call("bash", { command: "printf begin; sleep 0.1; printf end", background: true });
  const data = object(result.structuredContent);
  assert.equal(data.status, "running");
  assert.equal(data.exit_code, undefined);
  assert.ok(data.job_id);
  assert.match(result.content[0]!.type === "text" ? result.content[0].text : "", /Started in the background as requested\./);
  assert.doesNotMatch(result.content[0]!.type === "text" ? result.content[0].text : "", /If you do not want this task/);
  assert.match(result.content[0]!.type === "text" ? result.content[0].text : "", /do not poll/);
  assert.equal(h.statuses.get("pi-background-bash"), undefined);
  assert.ok(h.widgets.has("pi-background-bash"), "RPC 通过原生 widget 提供可展开的任务信息");
  await until(() => h.messages.length === 2);
  const completion = h.messages[0]!;
  assert.deepEqual(completion.options, { triggerTurn: false });
  assert.equal(completion.message.customType, "pi-background-bash:completion");
  assert.equal(completion.message.display, true);
  assert.equal(completion.message.details.id, data.job_id);
  assert.equal(completion.message.details.exit_code, 0);
  assert.match(completion.message.content, /beginend/);
  const wake = h.messages[1]!;
  assert.deepEqual(wake.options, { deliverAs: "followUp", triggerTurn: true });
  assert.equal(wake.message.customType, "pi-background-bash:wakeup");
  assert.equal(wake.message.display, false);
  assert.deepEqual(wake.message.details.jobIds, [data.job_id]);
  assert.equal(h.statuses.get("pi-background-bash"), undefined);
  await h.call("bash_jobs", { action: "output", id: data.job_id });
  assert.equal(h.messages.length, 2);
});

test("忙碌期间只保存完成事实，自然 settled 后批量唤醒一次", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  h.ctx.isIdle = () => false;
  await h.emit("agent_start");
  const first = object((await h.call("bash", { command: "printf first", background: true })).structuredContent).job_id;
  const second = object((await h.call("bash", { command: "printf second", background: true })).structuredContent).job_id;
  await until(() => h.messages.length === 2);
  assert.ok(h.messages.every(record => record.options.triggerTurn === false && record.message.display));
  h.ctx.isIdle = () => true;
  await h.emit("agent_end");
  await h.emit("agent_settled", h.ctx, { aborted: false });
  assert.equal(h.messages.length, 3);
  assert.equal(h.messages[2]!.message.display, false);
  assert.deepEqual(new Set(h.messages[2]!.message.details.jobIds), new Set([first, second]));
  await h.emit("agent_settled", h.ctx, { aborted: false });
  assert.equal(h.messages.length, 3, "完成记录和唤醒不能重复");
});

test("后续模型请求已读的完成任务不再唤醒，请求期间才完成的任务仍唤醒", async t => {
  for (const stopReason of ["stop", "toolUse", "length"]) {
    const h = harness();
    t.after(() => h.close());
    await h.emit("session_start");
    h.ctx.isIdle = () => false;
    await h.emit("agent_start");
    const first = object((await h.call("bash", { command: "printf first", background: true })).structuredContent).job_id;
    await until(() => h.messages.length === 1);
    await h.emit("turn_start");
    await h.emit("context_with_system", h.ctx, { messages: [{ role: "custom", ...h.messages[0]!.message }] });
    const second = object((await h.call("bash", { command: "printf second", background: true })).structuredContent).job_id;
    await until(() => h.messages.length === 2);
    await h.emit("message_end", h.ctx, { message: { role: "assistant", stopReason } });
    h.ctx.isIdle = () => true;
    await h.emit("agent_end");
    await h.emit("agent_settled", h.ctx, { aborted: false });
    assert.equal(h.messages.length, 3, stopReason);
    assert.deepEqual(h.messages[2]!.message.details.jobIds, [second], stopReason);
    assert.ok(!h.messages[2]!.message.details.jobIds.includes(first));
    assert.equal(h.messages[2]!.message.display, false);
  }
});

test("只准备上下文、请求失败或引用结果文本不算已读完成记录", async t => {
  for (const scenario of ["prepared-only", "start-only", "error", "pending", "deferred", "quoted", "foreign-details", "next-turn", "replaced-context"] as const) {
    const h = harness();
    try {
      await h.emit("session_start");
      h.ctx.isIdle = () => false;
      await h.emit("agent_start");
      const id = object((await h.call("bash", { command: "printf done", background: true })).structuredContent).job_id;
      await until(() => h.messages.length === 1);
      const completion = { role: "custom", ...h.messages[0]!.message };
      const messages = scenario === "quoted" ? [{ role: "user", content: completion.content }]
        : scenario === "foreign-details" ? [{ ...completion, details: { id, format: "another-extension" } }]
        : [completion];
      await h.emit("turn_start");
      await h.emit("context_with_system", h.ctx, { messages });
      if (scenario === "next-turn") await h.emit("turn_start");
      if (scenario === "replaced-context") await h.emit("context_with_system", h.ctx, { messages: [] });
      if (scenario === "start-only") await h.emit("message_start", h.ctx, { message: { role: "assistant", stopReason: "stop" } });
      if (scenario !== "prepared-only" && scenario !== "start-only") await h.emit("message_end", h.ctx, {
        message: { role: "assistant", stopReason: ["error", "pending", "deferred"].includes(scenario) ? scenario : "stop" },
      });
      h.ctx.isIdle = () => true;
      await h.emit("agent_end");
      await h.emit("agent_settled", h.ctx, { aborted: false });
      assert.equal(h.messages.length, 2, scenario);
      assert.deepEqual(h.messages[1]!.message.details.jobIds, [id], scenario);
    } finally {
      await h.close();
    }
  }
});

test("长轮次的唤醒指针有界，完成事实不因截尾丢失", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  h.ctx.isIdle = () => false;
  for (let i = 0; i < 22; i++) {
    await h.call("bash", { command: `printf ${i}`, background: true });
    await until(() => h.messages.length === i + 1);
  }
  assert.equal(h.messages.filter(record => record.message.customType === "pi-background-bash:completion").length, 22);
  h.ctx.isIdle = () => true;
  await h.emit("agent_end");
  await h.emit("agent_settled", h.ctx, { aborted: false });
  const wake = h.messages.at(-1)!;
  assert.equal(wake.message.details.jobIds.length, 20);
  assert.ok(!wake.message.details.jobIds.includes(h.messages[0]!.message.details.id));
});

test("截尾任务不会因最近二十个任务已读而失去最后一次唤醒", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  h.ctx.isIdle = () => false;
  for (let i = 0; i < 22; i++) {
    await h.call("bash", { command: `printf ${i}`, background: true });
    await until(() => h.messages.length === i + 1);
  }
  await h.emit("turn_start");
  await h.emit("context_with_system", h.ctx, {
    messages: h.messages.slice(-20).map(record => ({ role: "custom", ...record.message })),
  });
  await h.emit("message_end", h.ctx, { message: { role: "assistant", stopReason: "stop" } });
  h.ctx.isIdle = () => true;
  await h.emit("agent_end");
  await h.emit("agent_settled", h.ctx, { aborted: false });
  assert.equal(h.messages.length, 23);
  const wake = h.messages.at(-1)!;
  assert.equal(wake.message.customType, "pi-background-bash:wakeup");
  assert.deepEqual(wake.message.details.jobIds, []);
  assert.match(wake.message.content, /^Background bash tasks finished\. Their saved completion records/);
  assert.equal(wake.message.display, false);
  await h.emit("agent_settled", h.ctx, { aborted: false });
  assert.equal(h.messages.length, 23, "截尾补唤醒也只发送一次");
});

test("settled 分发和 Stop 之后完成均不唤醒，新的运行恢复自动通知", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("agent_end");
  // 模拟 SDK 已空闲、但前一个异步 settled 处理器尚未结束的窗口。
  const first = object((await h.call("bash", { command: "printf first", background: true })).structuredContent).job_id;
  await until(() => h.messages.length === 1);
  await h.emit("agent_settled", h.ctx, { aborted: true });
  await h.call("bash", { command: "printf late", background: true });
  await until(() => h.messages.length === 2);
  assert.ok(h.messages.every(record => record.options.triggerTurn === false));
  h.ctx.isIdle = () => false;
  await h.emit("agent_start");
  const resumed = object((await h.call("bash", { command: "printf resumed", background: true })).structuredContent).job_id;
  await until(() => h.messages.length === 3);
  h.ctx.isIdle = () => true;
  await h.emit("agent_end");
  await h.emit("agent_settled", h.ctx, { aborted: false });
  assert.equal(h.messages.length, 4);
  assert.deepEqual(h.messages[3]!.message.details.jobIds, [resumed]);
  assert.ok(!h.messages[3]!.message.details.jobIds.includes(first));
});

test("软超时转后台，状态和当前输出查询不等待完成，stop 返回终态", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  const result = await h.call("bash", { command: "printf one; sleep 5; printf two", timeout: 0.03 });
  assert.match(result.content[0]!.type === "text" ? result.content[0].text : "", /Foreground wait timed out after 0\.03s\. The command was not terminated; it was moved to the background\./);
  const id = object(result.structuredContent).job_id;
  const text = result.content[0]!.type === "text" ? result.content[0].text : "";
  assert.ok(text.includes(`If you do not want this task to continue in the background, stop it with bash_jobs({ action: "stop", id: "${id}" }).`));
  assert.match(text, /Stopping the agent alone will not stop this background task\./);
  await until(async () => object((await h.call("bash_jobs", { action: "output", id })).structuredContent).output === "one");
  const status = object((await h.call("bash_jobs", { action: "status", id })).structuredContent);
  assert.equal(status.job.status, "running");
  assert.equal(status.output, undefined);
  const stopped = object((await h.call("bash_jobs", { action: "stop", id })).structuredContent);
  assert.equal(stopped.job.status, "stopped");
  const output = object((await h.call("bash_jobs", { action: "output", id })).structuredContent);
  assert.equal(output.output, "one");
  await assert.rejects(h.call("bash_jobs", { action: "output" }), /id is required/);
});

test("原生 shell 配置、命令前缀和当前会话环境在前后台一致，Web 密码被移除", async t => {
  const old = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_PASSWORD = "must-not-leak";
  t.after(() => { if (old === undefined) delete process.env.PI_WEB_PASSWORD; else process.env.PI_WEB_PASSWORD = old; });
  const h = harness({ sessionId: "own-session", settings: { shellPath: "/bin/bash", shellCommandPrefix: "export JOB_PREFIX=ok" } });
  t.after(() => h.close());
  await h.emit("session_start");
  const command = "printf '%s|%s|%s|%s|%s|%s' \"$JOB_PREFIX\" \"$PI_SESSION_ID\" \"$PI_PROVIDER\" \"$PI_MODEL\" \"$PI_REASONING_LEVEL\" \"${PI_WEB_PASSWORD-unset}\"";
  const foreground = object((await h.call("bash", { command })).structuredContent);
  assert.equal(foreground.output, "ok|own-session|test-provider|test-model|high|unset");
  const background = object((await h.call("bash", { command, background: true })).structuredContent);
  await until(() => h.messages.length === 2);
  const output = object((await h.call("bash_jobs", { action: "output", id: background.job_id })).structuredContent);
  assert.equal(output.output, foreground.output);
  assert.equal(output.job.command, command);
  assert.ok(!h.messages[0]!.message.content.includes("export JOB_PREFIX=ok"));
});

test("大输出仍使用原生截断和完整输出路径；任务输出按字节和行双重限额", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  const result = await h.call("bash", { command: "for ((i=0;i<2500;i++)); do printf '%s line\\n' \"$i\"; done" });
  assert.equal(result.details.truncation.truncated, true);
  assert.ok(result.details.fullOutputPath);
  const large = object((await h.call("bash", { command: "for ((i=0;i<3000;i++)); do printf '%s line\\n' \"$i\"; done", background: true })).structuredContent);
  await until(() => h.messages.length === 2);
  const output = object((await h.call("bash_jobs", { action: "output", id: large.job_id, tail: 3 })).structuredContent);
  assert.equal(output.truncated, true);
  assert.equal(output.output, "2997 line\n2998 line\n2999 line");
  assert.ok(output.full_output_path);
});

test("print/JSON 模式不自动后台，保留原生硬超时，拒绝无法通知的显式后台", async t => {
  for (const mode of ["print", "json"] as const) {
    const h = harness({ mode });
    t.after(() => h.close());
    await h.emit("session_start");
    await assert.rejects(h.call("bash", { command: "printf no", background: true }), /Background execution is unavailable/);
    const description = h.tools.get("bash")!;
    assert.doesNotMatch(description.description, /background|TUI|RPC/);
    assert.match(object(description.parameters).properties.timeout.description, /Execution timeout.*no default timeout/);
    assert.equal(description.promptGuidelines?.some(rule => rule.includes("background=true")), false);
    await assert.rejects(h.call("bash", { command: "sleep 5", timeout: 0.03 }), /timed out/);
    const result = await h.call("bash", { command: "sleep 0.04; printf done" });
    assert.equal(object(result.structuredContent).output, "done");
    assert.equal(h.messages.length, 0);
  }
});

test("关闭或树导航时不把旧任务通知送到新上下文", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  const result = object((await h.call("bash", { command: "sleep 5; printf no", background: true })).structuredContent);
  await h.emit("session_tree");
  await delay(30);
  assert.equal(h.messages.length, 0);
  const list = object((await h.call("bash_jobs", { action: "list" })).structuredContent);
  assert.deepEqual(list.jobs, []);
  await assert.rejects(h.call("bash_jobs", { action: "status", id: result.job_id }), /Unknown job/);
});

test("手动后台命令和快捷键不依赖 TUI 定制界面", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  const pending = h.call("bash", { command: "sleep 0.2; printf done" });
  await until(async () => object((await h.call("bash_jobs", { action: "list" })).structuredContent).jobs.length === 1);
  await h.commands.get("bash-bg").handler("", h.ctx);
  const result = await pending;
  const data = object(result.structuredContent);
  assert.match(result.content[0]!.type === "text" ? result.content[0].text : "", /Moved to the background by manual request\./);
  assert.doesNotMatch(result.content[0]!.type === "text" ? result.content[0].text : "", /If you do not want this task/);
  assert.ok(data.job_id);
  assert.ok(h.shortcuts.has("ctrl+shift+b"));
  assert.match(h.notifications[0]!, /moved to background/);
});

test("Pi Web 保活只覆盖有活动任务的当前会话，关闭时释放", async t => {
  const key = Symbol.for("@agegr/pi-web/session-liveness/v1");
  const store = globalThis as Record<symbol, unknown>;
  const previous = store[key];
  let provider: { sessionId: string; isActive(): boolean } | undefined;
  let released = 0;
  store[key] = { version: 1, register: (value: typeof provider) => { provider = value; return () => { released++; }; } };
  t.after(() => { if (previous === undefined) delete store[key]; else store[key] = previous; });
  const h = harness({ sessionId: "web-session" });
  t.after(() => h.close());
  await h.emit("session_start");
  assert.equal(provider?.sessionId, "web-session");
  assert.equal(provider?.isActive(), false);
  await h.call("bash", { command: "sleep 5", background: true });
  assert.equal(provider?.isActive(), true);
  await h.emit("session_shutdown");
  assert.equal(released, 1);
});
