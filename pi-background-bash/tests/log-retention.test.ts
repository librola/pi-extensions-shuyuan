import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildSessionProjection, convertToLlm, createLocalBashOperations, SessionManager } from "@earendil-works/pi-coding-agent";
import { harness, until } from "./helpers.ts";
import { Backgrounded, JobManager, type JobSnapshot } from "../src/jobs.ts";
import { LogRetention, LOG_INDEX_NAME, keepLog } from "../src/log-retention.ts";
import { type OpenLogScan } from "../src/legacy-logs.ts";
import { LOG_MAX_AGE_MS, logReferences, SessionLogScanner, transcriptReferences } from "../src/log-context.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "log-retention-test-"));
  const sessions = join(root, "sessions"); mkdirSync(sessions);
  let now = Date.now();
  const writeSession = (file: string, content: string, time = now) => writeFileSync(file, [
    { type: "session", id: file, version: 3, cwd: root, timestamp: new Date(time).toISOString() },
    { type: "message", id: "u1", parentId: null, timestamp: new Date(time).toISOString(), message: { role: "user", content, timestamp: time } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const file = join(sessions, "session.jsonl"); writeSession(file, "ready");
  const stores: LogRetention[] = [];
  const store = (sessionFile = file, openLogProbe?: () => OpenLogScan) => {
    const result = new LogRetention({ sessionId: sessionFile, sessionFile, sessionRoot: sessions, root, now: () => now, openLogProbe,
      projection: () => buildSessionProjection(readFileSync(sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line)).slice(1)) });
    stores.push(result); return result;
  };
  t.after(() => { stores.forEach(store => store.close()); rmSync(root, { recursive: true, force: true }); });
  const log = (store: LogRetention, index = 0, running = false) => {
    const id = `job-${index.toString(16).padStart(8, "0")}`;
    const path = join(store.directory(), `${id}.log`); writeFileSync(path, "output");
    const job: JobSnapshot = { id, output_path: path, command: "printf output", cwd: root, status: running ? "running" : "completed", background: true,
      started_at: now, ended_at: running ? undefined : now, output_bytes: 6 };
    store.created(job, `call-${index}`);
    if (!running) store.finished(job);
    const content = `Background bash ${id}: completed. Full output: ${path}. output`;
    if (!running) store.completionContent(path, content);
    return { path, job, message: { role: "custom", customType: "pi-background-bash:completion", content, details: { ...job, format: "pi-background-bash.job.v1" } } };
  };
  const response = (store: LogRetention, messages: any[], reason = "stop", payload: unknown = { messages: messages.map(message => ({ content: message.content })) }) => {
    store.prepareContext(messages, true); store.providerPayload(payload); store.modelFinished({ stopReason: reason, content: [{ type: "text", text: "done" }] });
  };
  return { root, sessions, file, store, log, response, writeSession, advance: (milliseconds: number) => { now += milliseconds; }, now: () => now };
}

test("回收规则：运行和引用保护优先，未读七天边界独立于会话活动", () => {
  const now = Date.now(); const path = "/tmp/pi-background-bash-ABC123/job-12345678.log";
  const record = { path, id: "job-12345678", startedAt: now - LOG_MAX_AGE_MS, endedAt: now - LOG_MAX_AGE_MS, running: false, seen: false };
  assert.equal(keepLog(record, now, new Set(), now), true);
  assert.equal(keepLog(record, now, new Set(), now + 1), false);
  assert.equal(keepLog(record, now, new Set([path]), now + 1), true);
  assert.equal(keepLog({ ...record, running: true }, 0, new Set(), now), true);
  assert.equal(keepLog({ ...record, seen: true }, now, new Set([dirname(path)]), now), true);
  assert.equal(keepLog({ ...record, seen: true }, now, new Set(), now), false);
});

test("引用只来自模型正文与工具参数，不把 details 当成模型引用", () => {
  const path = "/tmp/pi-background-bash-ABC123/job-12345678.log";
  assert.deepEqual([...transcriptReferences([{ role: "toolResult", content: "done", details: { path } }], "/tmp")], []);
  assert.deepEqual([...transcriptReferences([{ role: "assistant", content: [{ type: "toolCall", arguments: { path } }] }], "/tmp")], [path]);
  assert.deepEqual([...logReferences({ command: "/tmp/pi-background-bash-ABC123/*.log" }, "/tmp")], [dirname(path)]);
  assert.deepEqual([...transcriptReferences([{ role: "system", content: "", sections: { logs: path } }], "/tmp")], [path]);
});

test("结果已读但路径仍在输入中保留，压缩后的确认输入无引用才回收", async t => {
  const f = fixture(t); const store = f.store(); const result = f.log(store);
  f.response(store, [result.message]);
  assert.equal((await store.collect()).deleted, 0);
  store.compacted();
  assert.equal((await store.collect()).deleted, 0, "仅压缩尚未确认新的实际请求时保留");
  f.response(store, [{ role: "user", content: "compressed summary" }]);
  assert.equal((await store.collect()).deleted, 1);
  assert.equal(existsSync(result.path), false);
  assert.equal(store.wasCollected(result.path), true);
});

test("身份字段不变但 context_edit 改写结果内容不能确认已读", async t => {
  const f = fixture(t); const store = f.store(); const result = f.log(store);
  f.response(store, [{ ...result.message, content: "replacement without original result" }]);
  assert.equal((await store.collect()).deleted, 0);
  f.advance(LOG_MAX_AGE_MS + 1); store.touch();
  assert.equal((await store.collect()).deleted, 1, "超过七天仅解除未读保护");
});

test("只准备上下文、提供方没有原文、错误或 Stop 均不提交已读", async t => {
  for (const reason of ["error", "aborted", "pending"]) {
    const f = fixture(t); const store = f.store(); const result = f.log(store);
    f.response(store, [result.message], reason);
    store.compacted(); f.response(store, [{ role: "user", content: "summary" }]);
    assert.equal((await store.collect()).deleted, 0, reason);
  }
  const f = fixture(t); const store = f.store(); const result = f.log(store);
  store.prepareContext([result.message], true); store.modelFinished({ stopReason: "stop" });
  f.response(store, [{ role: "user", content: "summary" }]);
  assert.equal((await store.collect()).deleted, 0, "没有传输层原文证据保持未读");
});

test("在途引用、正常响应新出现的路径以及后追加工具参数继续保护", async t => {
  const f = fixture(t); const store = f.store(); const result = f.log(store);
  f.response(store, [result.message]);
  store.compacted(); store.prepareContext([{ role: "user", content: "summary" }], true);
  assert.equal((await store.collect()).deleted, 0, "尚未收到正常响应不能撤旧保护");
  store.providerPayload({ messages: [{ content: "summary" }] });
  store.modelFinished({ stopReason: "toolUse", content: [{ type: "toolCall", arguments: { path: result.path } }] });
  assert.equal((await store.collect()).deleted, 0, "本轮响应提出的读取不能与 GC 竞争");
});

test("活跃会话的引用保护另一个已关闭写入者的日志", async t => {
  const f = fixture(t); const producer = f.store(); const result = f.log(producer);
  f.response(producer, [result.message]); producer.close();
  const child = join(f.sessions, "child.jsonl"); f.writeSession(child, result.path);
  const consumer = f.store(child); consumer.touch();
  assert.equal((await producer.collect()).deleted, 0);
});

test("七天不活跃只清理日志，不删除会话；读取和索引刷新不续命", async t => {
  const f = fixture(t); const store = f.store(); const result = f.log(store);
  store.close(); f.advance(LOG_MAX_AGE_MS + 1);
  const report = await store.collect();
  assert.equal(report.deleted, 1); assert.equal(report.removedDirectories, 1);
  assert.equal(existsSync(f.file), true);
  assert.equal(existsSync(result.path), false);
});

test("目录索引独立于二十条内存记录，已读批次压缩后可完整回收", async t => {
  const f = fixture(t); const store = f.store(); const results = Array.from({ length: 25 }, (_, index) => f.log(store, index));
  f.response(store, results.map(result => result.message));
  store.compacted(); f.response(store, [{ role: "user", content: "summary" }]);
  assert.equal((await store.collect()).deleted, 25);
  const metadata = JSON.parse(readFileSync(join(store.directory(), LOG_INDEX_NAME), "utf8"));
  assert.equal(metadata.records.length, 0);
  assert.equal(metadata.collected.length, 20);
});

test("被回收的前台完整日志不改变退出状态，输出查询明确说明原因", async t => {
  const f = fixture(t); const store = f.store();
  const jobs = new JobManager(createLocalBashOperations(), () => {}, undefined, store);
  t.after(() => jobs.shutdown());
  await jobs.run("printf foreground", f.root, { toolCallId: "front-call" });
  const job = jobs.list()[0]!;
  f.advance(1000);
  const message = { role: "toolResult", toolCallId: "front-call", timestamp: f.now(), content: [{ type: "text", text: "foreground" }] };
  store.observedToolResult(message);
  f.response(store, [message], "stop", { messages: [{ role: "tool", tool_call_id: "front-call", content: "foreground" }] });
  assert.equal((await store.collect()).deleted, 1);
  assert.equal(jobs.get(job.id).status, "completed");
  assert.throws(() => jobs.output(job.id), /reclaimed by log retention/);
  assert.equal(jobs.get(job.id).exit_code, 0);
});

test("运行中 handoff 不能把后来才完成的后台结果提前标为已读", async t => {
  const f = fixture(t); const store = f.store(); const result = f.log(store, 0, true);
  const handoff = { role: "toolResult", toolCallId: "call-0", timestamp: f.now(), content: [{ type: "text", text: "running" }] };
  store.observedToolResult(handoff); f.response(store, [handoff], "toolUse", { messages: [{ tool_call_id: "call-0", content: "running" }] });
  store.finished({ ...result.job, background: true, status: "completed", ended_at: f.now() });
  store.completionContent(result.path, result.message.content);
  f.response(store, [{ role: "user", content: "summary" }]);
  assert.equal((await store.collect()).deleted, 0);
});

test("坏行和无法扫描的上下文不产生无引用证明", async t => {
  const f = fixture(t); const store = f.store(); const result = f.log(store);
  t.mock.method(console, "error", () => {});
  f.response(store, [result.message]); f.response(store, [{ role: "user", content: "summary" }]);
  writeFileSync(f.file, readFileSync(f.file, "utf8") + "not-json /pi-background-bash-ABC123\n");
  const report = await store.collect();
  assert.equal(report.skippedUnknown, true); assert.equal(existsSync(result.path), true);
});

test("扫描压缩摘要和有效保留区，不以原始历史中的路径保留日志", async t => {
  const f = fixture(t); const path = join(f.root, "pi-background-bash-ABC123", "job-12345678.log");
  const time = new Date(f.now()).toISOString();
  const entries = [
    { type: "session", id: "test", version: 3, cwd: f.root, timestamp: time },
    { type: "message", id: "old", parentId: null, timestamp: time, message: { role: "user", content: path } },
    { type: "message", id: "keep", parentId: "old", timestamp: time, message: { role: "user", content: "kept" } },
    { type: "compaction", id: "compact", parentId: "keep", timestamp: time, summary: "summary", firstKeptEntryId: "keep", tokensBefore: 100 },
  ];
  writeFileSync(f.file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const scanner = new SessionLogScanner();
  const scan = await scanner.scan(f.sessions, f.root);
  assert.equal(scan.complete, true);
  assert.equal(scan.contexts.get(f.file)!.references.has(path), false);
  entries[3]!.summary = path;
  writeFileSync(f.file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  assert.equal((await scanner.scan(f.sessions, f.root)).contexts.get(f.file)!.references.has(path), true);
});


test("旧日志七天后仅在完整 fd 检查且无引用时删除，年轻旧日志保留", async t => {
  const f = fixture(t);
  const directory = join(f.root, "pi-background-bash-OLD123"); mkdirSync(directory);
  const path = join(directory, "job-deadbeef.log"); writeFileSync(path, "old output");
  const store = f.store(f.file, () => ({ paths: new Set(), complete: true }));
  assert.equal((await store.collect()).deleted, 0);
  f.advance(LOG_MAX_AGE_MS + 1);
  const report = await store.collect();
  assert.equal(report.deleted, 1); assert.equal(existsSync(directory), false);
  assert.equal(existsSync(f.file), true);
});

test("旧日志缺少 fd 覆盖、仍被打开或仍被活跃上下文引用时不删", async t => {
  for (const reason of ["unknown", "open", "reference"]) {
    const f = fixture(t); const directory = join(f.root, "pi-background-bash-OLD123"); mkdirSync(directory);
    const path = join(directory, "job-deadbeef.log"); writeFileSync(path, "old output");
    f.advance(LOG_MAX_AGE_MS + 1);
    if (reason === "reference") f.writeSession(f.file, path);
    const store = f.store(f.file, () => ({ paths: new Set(reason === "open" ? [path] : []), complete: reason !== "unknown" }));
    const report = await store.collect();
    assert.equal(report.deleted, 0, reason); assert.equal(existsSync(path), true);
  }
});

test("已结束日志在回收前被用户修改时保留，不误删替换后的内容", async t => {
  const f = fixture(t); const store = f.store(); const result = f.log(store);
  f.response(store, [result.message]); f.response(store, [{ role: "user", content: "summary" }]);
  writeFileSync(result.path, "new user data");
  assert.equal((await store.collect()).deleted, 0);
  assert.equal(readFileSync(result.path, "utf8"), "new user data");
});

test("请求中途压缩会使旧无引用证明失效，失败后不回收", async t => {
  const f = fixture(t); const store = f.store(); const result = f.log(store);
  f.response(store, [result.message]);
  store.prepareContext([{ role: "user", content: "summary" }], true); store.providerPayload({ messages: [{ content: "summary" }] });
  store.compacted(); store.modelFinished({ stopReason: "stop" });
  assert.equal((await store.collect()).deleted, 0);
});

test("确认请求之后出现的 context_edit 引用不能被旧确认快照覆盖", async t => {
  const f = fixture(t); const store = f.store(); const result = f.log(store);
  f.response(store, [result.message]); f.response(store, [{ role: "user", content: "summary" }]);
  const edit = { type: "context_edit", id: "edit", parentId: "u1", targetId: "u1", timestamp: new Date(f.now()).toISOString(), replacement: { content: result.path } };
  writeFileSync(f.file, readFileSync(f.file, "utf8") + JSON.stringify(edit) + "\n");
  assert.equal((await store.collect()).deleted, 0);
});

test("观察失败或目录索引错误时不猜测已读，恢复正常请求后再回收", async t => {
  const f = fixture(t); const store = f.store(); const result = f.log(store);
  f.response(store, [result.message]); store.observationFailed();
  assert.equal((await store.collect()).skippedUnknown, true);
  assert.equal(existsSync(result.path), true);
  f.response(store, [{ role: "user", content: "summary" }]);
  assert.equal((await store.collect()).deleted, 1);
});


test("原生扩展通过公开请求和压缩事件回收日志，完成事实仍唯一保留", async t => {
  const root = mkdtempSync(join(tmpdir(), "log-retention-extension-"));
  const session = SessionManager.create(root, join(root, "sessions"));
  session.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
  const h = harness({ cwd: root });
  h.ctx.sessionManager = session;
  t.after(async () => { await h.close(); rmSync(root, { recursive: true, force: true }); });
  await h.emit("session_start"); h.ctx.isIdle = () => false;
  const result = await h.call("bash", { command: "printf retained-result", background: true });
  const path = (result.structuredContent as { full_output_path: string }).full_output_path;
  await until(() => h.messages.length === 1);
  const message = h.messages[0]!.message;
  session.appendCustomMessageEntry(message.customType, message.content, true, message.details);
  const send = async () => {
    const messages = session.buildSessionProjection().messages;
    await h.emit("context_with_system", h.ctx, { messages });
    await h.emit("before_provider_request", h.ctx, { payload: { messages: convertToLlm(messages) } });
    await h.emit("message_end", h.ctx, { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });
    await h.emit("agent_settled", h.ctx, { aborted: false });
  };
  await send();
  assert.equal(existsSync(path), true);
  const kept = session.appendMessage({ role: "user", content: "fresh", timestamp: Date.now() });
  session.appendCompaction("summary without log paths", kept, 100);
  await h.emit("session_compact");
  await send();
  await until(() => !existsSync(path));
  assert.equal(h.messages.filter(item => item.message.customType === "pi-background-bash:completion").length, 1);
  assert.equal(readFileSync(session.getSessionFile()!, "utf8").includes(message.details.id), true);
});


test("reload 后读取旧结果的确认持久传播，新上下文可以回收旧目录", async t => {
  const f = fixture(t); const producer = f.store(); const result = f.log(producer); producer.close();
  const reader = f.store(); f.response(reader, [result.message]);
  assert.equal((await reader.collect()).deleted, 0);
  const metadata = JSON.parse(readFileSync(join(dirname(result.path), LOG_INDEX_NAME), "utf8"));
  assert.equal(metadata.records[0].seen, true, "全局已读事实必须写回原目录，而不依赖临时 seenHints");
  const readerDirectory = reader.directory(); reader.close();
  const resumed = f.store(); f.response(resumed, [{ role: "user", content: "summary" }]);
  assert.equal((await resumed.collect()).deleted, 1);
  assert.equal(existsSync(result.path), false);
  assert.equal(existsSync(readerDirectory), false, "没有日志的旧控制索引也不能无限占 inode");
});

test("同一前台结果身份在正文被替换后仍保持未读", async t => {
  const f = fixture(t); const store = f.store(); const result = f.log(store);
  store.finished({ ...result.job, background: false });
  const message = { role: "toolResult", toolCallId: "call-0", timestamp: f.now(), content: [{ type: "text", text: "original" }] };
  store.observedToolResult(message);
  f.response(store, [{ ...message, content: [{ type: "text", text: "replacement" }] }], "stop", { messages: [{ tool_call_id: "call-0", content: "replacement" }] });
  assert.equal((await store.collect()).deleted, 0);
});

test("关闭标记晚于日志 fd 释放，不把 shutdown 开始误认为已经停止写入", async t => {
  const f = fixture(t); const store = f.store();
  let aborted = false; let release: (() => void) | undefined;
  const operations = { ...createLocalBashOperations(), exec: async (_command: string, _cwd: string, options: { signal?: AbortSignal }) => {
    options.signal!.addEventListener("abort", () => { aborted = true; });
    return await new Promise<{ exitCode: number }>(resolve => { release = () => resolve({ exitCode: 0 }); });
  } };
  const jobs = new JobManager(operations, () => {}, undefined, store);
  t.after(async () => { release?.(); await jobs.shutdown(); });
  await assert.rejects(jobs.run("blocked", f.root, { background: true }), Backgrounded);
  const indexPath = join(store.directory(), LOG_INDEX_NAME);
  const shutdown = jobs.shutdown();
  await until(() => aborted);
  assert.equal(JSON.parse(readFileSync(indexPath, "utf8")).closed, false);
  assert.equal(JSON.parse(readFileSync(indexPath, "utf8")).records[0].running, true);
  release!(); await shutdown; store.close();
  assert.equal(JSON.parse(readFileSync(indexPath, "utf8")).closed, true);
  assert.equal(JSON.parse(readFileSync(indexPath, "utf8")).records[0].running, false);
});


test("索引落盘失败暂停同一根的回收，恢复后可安全重试", async t => {
  const f = fixture(t); const store = f.store(); const result = f.log(store);
  f.response(store, [result.message]); f.response(store, [{ role: "user", content: "summary" }]);
  const index = join(store.directory(), LOG_INDEX_NAME);
  t.mock.method(console, "error", () => {});
  rmSync(index); mkdirSync(index); store.touch();
  assert.equal((await store.collect()).skippedUnknown, true);
  assert.equal(existsSync(result.path), true);
  rmSync(index, { recursive: true }); store.touch();
  assert.equal((await store.collect()).deleted, 1);
});

test("reload 后新正常请求可替代旧观察失败，不能永久留下未知控制目录", async t => {
  const f = fixture(t); const old = f.store(); const result = f.log(old);
  f.response(old, [result.message]); old.observationFailed(); old.close();
  f.advance(1000);
  const current = f.store(); f.response(current, [{ role: "user", content: "summary" }]);
  assert.equal((await current.collect()).deleted, 1);
  assert.equal(existsSync(result.path), false);
});


test("回收墓碑按完成时间保留，早启动晚结束的最近任务仍能说明已回收", async t => {
  const f = fixture(t); const store = f.store(); const late = f.log(store, 0, true);
  f.advance(1000);
  const results = Array.from({ length: 24 }, (_, index) => f.log(store, index + 1));
  f.advance(1000); store.finished({ ...late.job, status: "completed", ended_at: f.now() }); store.completionContent(late.path, late.message.content);
  f.response(store, [...results.map(result => result.message), late.message]);
  f.response(store, [{ role: "user", content: "summary" }]);
  assert.equal((await store.collect()).deleted, 25);
  assert.equal(store.wasCollected(late.path), true);
});
