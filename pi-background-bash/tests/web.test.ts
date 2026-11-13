import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { historyRecords, isJob, JOB_FORMAT, jobsFromDetails, mergeRecords, statusLabel } from "../web/parse.js";
import { activate } from "../web/browser.js";
import { JOB_FORMAT as nativeFormat } from "../src/rpc.ts";
import type { Job, HistoryEntry, WebHost } from "../web/api.d.ts";

const job: Job = { id: "job-12345678", command: "printf hello", cwd: "/tmp/example", status: "running", background: true, started_at: 100, output_path: "/tmp/owned.log", output_bytes: 5 };

test("渲染匹配要求自有格式和合法任务，不按工具名误接管其他插件", () => {
  assert.equal(JOB_FORMAT, nativeFormat);
  assert.ok(isJob(job));
  assert.deepEqual(jobsFromDetails({ job }), []);
  assert.deepEqual(jobsFromDetails({ format: "other", job }), []);
  assert.deepEqual(jobsFromDetails({ format: JOB_FORMAT, job: { ...job, status: "unknown" } }), []);
  assert.deepEqual(jobsFromDetails({ format: JOB_FORMAT, job }), [job]);
});

test("历史合并保留完成真值、输出摘要，隐藏消息和旧格式不进入面板", () => {
  const entries: HistoryEntry[] = [
    { id: "call", type: "message", message: { role: "toolResult", toolName: "bash", details: { format: JOB_FORMAT, job } } },
    { id: "finished", type: "message", message: { role: "custom", customType: "pi-background-bash:completion", details: { ...job, status: "completed", exit_code: 0, ended_at: 200, format: JOB_FORMAT, output: "hello" } } },
    { id: "hidden", type: "message", message: { role: "custom", customType: "pi-background-bash:completion", display: false, details: { ...job, id: "job-00000001", format: JOB_FORMAT } } },
    { id: "foreign", type: "message", message: { role: "toolResult", toolName: "bash", details: { job: { ...job, id: "job-00000002" } } } },
  ];
  const records = historyRecords(entries);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.job.status, "completed");
  assert.equal(records[0]!.output, "hello");
  assert.equal(statusLabel({ job, origin: "history" }), "历史记录 · 当前状态未确认");
  const merged = mergeRecords(records, [{ ...job, status: "stopped" }], true);
  assert.equal(merged[0]!.origin, "live");
  assert.equal(merged[0]!.job.status, "stopped");
  assert.equal(mergeRecords(records, [job], false)[0]!.job.status, "completed");
});

test("历史页先旧后新，重复任务不复活，展示记录有明确上限", () => {
  const entries = Array.from({ length: 250 }, (_, index): HistoryEntry => ({ id: String(index), type: "message", message: {
    role: "toolResult", toolName: "bash", details: { format: JOB_FORMAT, job: { ...job, id: `job-${index.toString(16).padStart(8, "0")}`, started_at: index } },
  } }));
  const records = historyRecords(entries);
  assert.equal(records.length, 200);
  assert.equal(records[0]!.job.started_at, 249);
});

test("Web 注册只占顶部下拉入口，不注册侧栏面板，注册和样式可清理", t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  let removedStyles = 0;
  let stylesheet = "";
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: () => ({ rel: "", href: "", remove: () => { removedStyles++; } }),
    head: { appendChild: (link: { href: string }) => { stylesheet = link.href; } },
  } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "document", descriptor); else Reflect.deleteProperty(globalThis, "document"); });
  const registrations = new Map<string, any>();
  let removedRegistrations = 0;
  const register = (kind: string) => (value: any) => { registrations.set(kind, value); return () => { removedRegistrations++; }; };
  const react = {
    createElement: (type: any, props: any, ...children: any[]): any => typeof type === "function" ? type({ ...props, children }) : { type, props, children },
    useState: (initial: any) => [initial, () => {}],
  };
  const host = {
    apiVersion: 1, react, extension: { assetBaseUrl: "/approved/" },
    registerPanel: register("panel"), registerToolbarItem: register("toolbar"),
    registerToolRenderer: register("tool"), registerMessageRenderer: register("message"), registerWebCommand: register("command"),
  } as unknown as WebHost;
  const remove = activate(host);
  assert.equal(stylesheet, "/approved/web/style.css");
  assert.equal(registrations.get("tool").match({ tool: { toolName: "bash" }, result: { details: { format: JOB_FORMAT, job } } }), true);
  assert.equal(registrations.get("tool").match({ tool: { toolName: "bash" }, result: { details: { job } } }), false);
  assert.ok(!registrations.has("panel"));
  assert.equal(registrations.get("command").name, "bash-jobs");
  assert.throws(() => registrations.get("command").run({ context: {} }), /尚未就绪/);
  const nativeView = react.createElement("button", { id: "native-copy" }, "Copy");
  const buttons = (node: any): any[] => Array.isArray(node) ? node.flatMap(buttons) : node && typeof node === "object"
    ? [...(node.type === "button" ? [node] : []), ...(node.children ?? []).flatMap(buttons)] : [];
  const context = { sessionId: "own-session", signal: new AbortController().signal };
  const toolCard = registrations.get("tool").component({ result: { details: { format: JOB_FORMAT, job } }, context, defaultView: nativeView });
  const completionCard = registrations.get("message").component({ message: { details: { ...job, format: JOB_FORMAT, status: "completed", ended_at: 200 } }, context, defaultView: nativeView });
  assert.deepEqual(buttons(toolCard), [nativeView], "工具输出不能额外添加打开顶栏的按钮，原生按钮仍保留");
  assert.deepEqual(buttons(completionCard), [nativeView], "完成消息也不添加重复入口");
  remove();
  assert.equal(removedRegistrations, 4);
  assert.equal(removedStyles, 1);
});

test("打包声明只服务预构建 Web 资产，桥和原生源代码不公开", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.pi.extensions[0], "./src/index.ts");
  assert.equal(manifest.piWeb.entry, "web/browser.js");
  assert.ok(!manifest.piWeb.assets.includes(manifest.piWeb.bridge.entry));
  assert.ok(!manifest.piWeb.assets.some((path: string) => path.startsWith("src/") || path.endsWith(".d.ts")));
  assert.ok(manifest.piWeb.bridge.actions.every((action: { session: string }) => action.session === "active"));
  const permissions = manifest.piWeb.bridge.permissions.events[0];
  assert.deepEqual(permissions.queryMethods, ["ping", "list", "status", "output"]);
  assert.ok(!permissions.queryMethods.includes("stop"));
});
