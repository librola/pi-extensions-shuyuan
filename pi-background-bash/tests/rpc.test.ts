import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { JOB_FORMAT, PACKAGE_VERSION, RPC_REPLY_PREFIX, RPC_REQUEST } from "../src/rpc.ts";
import { harness, until } from "./helpers.ts";
import { rpc } from "./rpc-helpers.ts";

test("原生公开协议报告实际版本、能力和会话身份，查询不唤醒模型", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(PACKAGE_VERSION, manifest.version);
  const ping = await rpc(h.events, "ping");
  assert.equal(ping.version, 1);
  assert.equal(ping.success, true);
  assert.equal(ping.data.sessionId, "session-test");
  assert.equal(ping.data.format, JOB_FORMAT);
  assert.ok(ping.data.methods.includes("output"));
  const result = await h.call("bash", { command: "printf first; sleep 5", background: true });
  const id = (result.structuredContent as Record<string, unknown>).job_id;
  await until(async () => (await rpc(h.events, "output", { id })).data.output === "first");
  const status = await rpc(h.events, "status", { id });
  assert.equal(status.data.job.status, "running");
  assert.equal(status.data.job.exit_code, undefined);
  assert.equal(status.data.output, undefined);
  const list = await rpc(h.events, "list");
  assert.equal(list.data.jobs.length, 1);
  assert.equal(h.messages.length, 0);
});

test("协议只允许已有任务操作，拒绝越界参数、路径和不兼容版本", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  for (const request of [
    { method: "run", params: { command: "touch no" } },
    { method: "output", params: { id: "../../etc/passwd" } },
    { method: "output", params: { id: "job-12345678", tail: 2001 } },
    { method: "list", params: { command: "no" } },
    { method: "ping", params: {}, extra: { version: 2 } },
  ]) {
    const reply = await rpc(h.events, request.method, request.params, request.extra);
    assert.equal(reply.success, false);
    assert.equal(typeof reply.error, "string");
  }
  assert.deepEqual((await rpc(h.events, "list")).data.jobs, []);
  assert.equal(h.messages.length, 0);
});

test("协议的 stop 终止原任务，background 移交原前台命令而不重新执行", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  const pending = h.call("bash", { command: "printf once; sleep 5", timeout: 20 });
  await until(async () => (await rpc(h.events, "list")).data.jobs.length === 1);
  const id = (await rpc(h.events, "list")).data.jobs[0].id;
  const moved = await rpc(h.events, "background", { id });
  assert.equal(moved.success, true);
  assert.equal(moved.data.job.background, true);
  assert.equal((await pending).details.job.id, id);
  await until(async () => (await rpc(h.events, "output", { id })).data.output === "once");
  const stopped = await rpc(h.events, "stop", { id });
  assert.equal(stopped.success, true);
  assert.equal(stopped.data.job.status, "stopped");
  assert.equal((await rpc(h.events, "output", { id })).data.output, "once");
});

test("同目录的不同会话不能经事件协议查询或停止彼此任务", async t => {
  const first = harness({ sessionId: "first" });
  const second = harness({ cwd: first.cwd, sessionId: "second" });
  t.after(async () => { await second.close(); await first.close(); });
  await first.emit("session_start"); await second.emit("session_start");
  const result = await first.call("bash", { command: "sleep 5", background: true });
  const id = (result.structuredContent as Record<string, unknown>).job_id;
  assert.equal((await rpc(second.events, "stop", { id })).success, false);
  assert.equal((await rpc(first.events, "status", { id })).data.job.status, "running");
});

test("生命周期结束后注销请求监听，旧请求不产生迟到回包", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  await h.emit("session_shutdown");
  let replies = 0;
  const off = h.events.on(RPC_REPLY_PREFIX + "old-request", () => { replies++; });
  h.events.emit(RPC_REQUEST, { requestId: "old-request", version: 1, method: "list", params: {} });
  await delay(20);
  off();
  assert.equal(replies, 0);
});
