import assert from "node:assert/strict";
import { test } from "node:test";
import { readBackgroundCount } from "../web/counter.js";
import { RPC_REQUEST } from "../web/parse.js";
import type { ViewContext } from "../web/api.d.ts";

function context(overrides: Partial<ViewContext> = {}): ViewContext {
  return {
    sessionId: "own-session", signal: new AbortController().signal,
    readCapabilities: async () => ({ active: true, events: [RPC_REQUEST], commands: [] }),
    invokeAction: async () => ({ result: { running: 2 }, leafId: null }),
    ...overrides,
  } as ViewContext;
}

test("顶部只调用 count 查询，真实的 0 和正整数可显示", async () => {
  for (const value of [0, 2, 16]) {
    const calls: string[] = [];
    const current = context({ invokeAction: async (name, input) => {
      calls.push(name); assert.deepEqual(input, {});
      return { result: { running: value }, leafId: null };
    } });
    assert.equal(await readBackgroundCount(current), value);
    assert.deepEqual(calls, ["count"]);
  }
});

test("没有会话或兼容的活动目标时不执行桥动作，也不显示假 0", async () => {
  const unavailable = async () => { throw new Error("不应该调用"); };
  assert.equal(await readBackgroundCount(context({ sessionId: null, readCapabilities: unavailable, invokeAction: unavailable })), null);
  for (const capabilities of [{ active: false, events: [RPC_REQUEST] }, { active: true, events: [] }]) {
    assert.equal(await readBackgroundCount(context({ readCapabilities: async () => ({ ...capabilities, commands: [] }), invokeAction: unavailable })), null);
  }
});

test("非法计数和查询失败不会变成 0", async () => {
  for (const result of [null, {}, { running: "1" }, { running: -1 }, { running: 1.5 }, { running: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(await readBackgroundCount(context({ invokeAction: async () => ({ result, leafId: null }) })), null);
  }
  await assert.rejects(readBackgroundCount(context({ invokeAction: async () => { throw new Error("查询失败"); } })), /查询失败/);
});

test("页面隐藏时不开始查询，能力检查期间隐藏也不继续发计数请求", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const document = { hidden: true };
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); });
  const unavailable = async () => { throw new Error("不应该调用"); };
  assert.equal(await readBackgroundCount(context({ readCapabilities: unavailable, invokeAction: unavailable })), null);
  document.hidden = false;
  assert.equal(await readBackgroundCount(context({ readCapabilities: async () => {
    document.hidden = true; return { active: true, events: [RPC_REQUEST], commands: [] };
  }, invokeAction: unavailable })), null);
});

test("视图在能力检查或查询期间失效时丢弃计数，不发送后续动作", async () => {
  const controller = new AbortController();
  let actions = 0;
  const current = context({ signal: controller.signal,
    readCapabilities: async () => { controller.abort(); return { active: true, events: [RPC_REQUEST], commands: [] }; },
    invokeAction: async () => { actions++; return { result: { running: 1 }, leafId: null }; },
  });
  assert.equal(await readBackgroundCount(current), null);
  assert.equal(await readBackgroundCount(current), null);
  assert.equal(actions, 0);
  const second = new AbortController();
  assert.equal(await readBackgroundCount(context({ signal: second.signal, invokeAction: async () => {
    second.abort(); return { result: { running: 1 }, leafId: null };
  } })), null);
});
