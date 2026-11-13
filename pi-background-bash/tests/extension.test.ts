import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { harness, until } from "./helpers.ts";

function object(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}

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

test("主动后台返回 job_id 而不是假退出码，完成通过 followUp 唤醒模型", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  const result = await h.call("bash", { command: "printf begin; sleep 0.1; printf end", background: true });
  const data = object(result.structuredContent);
  assert.equal(data.status, "running");
  assert.equal(data.exit_code, undefined);
  assert.ok(data.job_id);
  assert.match(result.content[0]!.type === "text" ? result.content[0].text : "", /do not poll/);
  assert.equal(h.statuses.get("pi-background-bash"), "bash jobs: 1");
  await until(() => h.messages.length === 1);
  const completion = h.messages[0]!;
  assert.deepEqual(completion.options, { deliverAs: "followUp", triggerTurn: true });
  assert.equal(completion.message.customType, "pi-background-bash:completion");
  assert.equal(completion.message.details.id, data.job_id);
  assert.equal(completion.message.details.exit_code, 0);
  assert.match(completion.message.content, /beginend/);
  assert.equal(h.statuses.get("pi-background-bash"), undefined);
  await h.call("bash_jobs", { action: "output", id: data.job_id });
  assert.equal(h.messages.length, 1);
});

test("软超时转后台，状态和当前输出查询不等待完成，stop 返回终态", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  const result = await h.call("bash", { command: "printf one; sleep 5; printf two", timeout: 0.03 });
  const id = object(result.structuredContent).job_id;
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
  await until(() => h.messages.length === 1);
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
  await until(() => h.messages.length === 1);
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
    await assert.rejects(h.call("bash", { command: "printf no", background: true }), /persistent TUI\/RPC/);
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
  const data = object((await pending).structuredContent);
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
