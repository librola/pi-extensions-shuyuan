import assert from "node:assert/strict";
import { test } from "node:test";
import { actions } from "../web/bridge.mjs";
import { JOB_FORMAT } from "../src/rpc.ts";
import { harness, until } from "./helpers.ts";
import { rpc } from "./rpc-helpers.ts";
import type { BridgeHost } from "../web/api.d.ts";

test("Web 桥通过公共事件协议查询、读取和停止同一个原生任务", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start");
  const host: BridgeHost = {
    sessionId: "session-test", signal: new AbortController().signal,
    requestEvent: (_name, payload) => rpc(h.events, payload.method as string, payload.params as Record<string, unknown>),
  };
  const result = await h.call("bash", { command: "printf bridge-output; sleep 5", background: true });
  const id = (result.structuredContent as Record<string, unknown>).job_id;
  const list = await actions.list({}, host);
  assert.equal((list.jobs as Array<{ id: string }>)[0]!.id, id);
  assert.deepEqual(await actions.count({}, host), { running: 1 });
  await until(async () => (await actions.output({ id }, host)).output === "bridge-output");
  const stopped = await actions.stop({ id }, host);
  assert.equal((stopped.job as { status: string }).status, "stopped");
  assert.deepEqual(await actions.count({}, host), { running: 0 });
});

test("计数复用旧版原生 list，只统计后台运行任务且只回传数量", async () => {
  const methods: unknown[] = [];
  const host: BridgeHost = {
    sessionId: "own-session", signal: new AbortController().signal,
    requestEvent: async (_name, input) => {
      methods.push(input.method);
      return { version: 1, success: true, data: input.method === "ping"
        ? { sessionId: "own-session", packageVersion: "0.2.0", format: JOB_FORMAT, methods: ["ping", "list"] }
        : { jobs: [{ background: true, status: "running", command: "private-command" }, { background: true, status: "running" },
          { background: false, status: "running" }, { background: true, status: "stopped" }, { background: true, status: "completed" }] } };
    },
  };
  assert.deepEqual(await actions.count({}, host), { running: 2 });
  assert.deepEqual(methods, ["ping", "list"]);
});

test("任务列表格式错误时拒绝计数，不把未知字段误算为 0", async () => {
  for (const jobs of [null, [{ status: "running" }], [{ background: true, status: ["running"] }], [{ background: true, status: "unknown" }], Array(65).fill({ background: false, status: "completed" })]) {
    const host: BridgeHost = {
      sessionId: "own-session", signal: new AbortController().signal,
      requestEvent: async (_name, input) => ({ version: 1, success: true, data: input.method === "ping"
        ? { sessionId: "own-session", packageVersion: "0.2.0", format: JOB_FORMAT, methods: ["list"] } : { jobs } }),
    };
    await assert.rejects(actions.count({}, host), /Unsupported/);
  }
});

test("运行实例身份或版本不匹配时只握手，不转发写操作", async () => {
  for (const change of [{ packageVersion: "1.1.0" }, { sessionId: "other-session" }, { format: "other-format" }, { methods: ["list"] }]) {
    const methods: unknown[] = [];
    const host: BridgeHost = {
      sessionId: "own-session", signal: new AbortController().signal,
      requestEvent: async (_name, input) => {
        methods.push(input.method);
        return { version: 1, success: true, data: { sessionId: "own-session", packageVersion: "0.2.0", format: JOB_FORMAT, methods: ["stop"], ...change } };
      },
    };
    await assert.rejects(actions.stop({ id: "job-12345678" }, host), /Compatible/);
    assert.deepEqual(methods, ["ping"]);
  }
});

test("失效视图不发请求，握手期间中止也不转发 mutation", async () => {
  const controller = new AbortController();
  const methods: unknown[] = [];
  const host: BridgeHost = {
    sessionId: "own-session", signal: controller.signal,
    requestEvent: async (_name, input) => {
      methods.push(input.method);
      controller.abort();
      return { version: 1, success: true, data: { sessionId: "own-session", packageVersion: "0.2.0", format: JOB_FORMAT, methods: ["stop"] } };
    },
  };
  await assert.rejects(actions.stop({ id: "job-12345678" }, host), /expired/);
  assert.deepEqual(methods, ["ping"]);
  await assert.rejects(actions.list({}, host), /expired/);
  assert.deepEqual(methods, ["ping"]);
});

test("传输成功不等于操作成功，桥拒绝错误或不支持的回包", async () => {
  for (const reply of [{ version: 1, success: false, error: "Unknown job" }, { version: 2, success: true, data: {} }, null]) {
    const host: BridgeHost = { sessionId: "session", signal: new AbortController().signal, requestEvent: async () => reply };
    await assert.rejects(actions.list({}, host));
  }
});
