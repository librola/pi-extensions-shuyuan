import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { previousRetry, RECOVERY_ENTRY, registerErrorRetry } from "../index.ts";
import { policyKey } from "../src/rules.ts";

function commandFixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-error-retry-command-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "rules.json");
	const handlers = new Map();
	let command;
	registerErrorRetry({
		on: (name, handler) => { handlers.set(name, handler); },
		registerCommand: (name, definition) => { assert.equal(name, "error-retry"); command = definition.handler; },
	}, path);
	const notices = [];
	const ctx = { cwd: directory, hasUI: true, ui: { notify: (message, type) => notices.push({ message, type }) } };
	return { directory, path, handlers, command, notices, ctx };
}

test("Pi 规则编辑器保存校验失败保留草稿，保存成功后才通知", async (t) => {
	const f = commandFixture(t);
	const invalid = '{"rules":[{"mode":"regex","pattern":"["}]}';
	const valid = '{"rules":[{"mode":"contains","pattern":"custom"}]}';
	let edits = 0;
	f.ctx.ui.editor = async (_title, draft) => {
		if (edits++ === 0) return invalid;
		assert.equal(draft, invalid);
		return valid;
	};
	f.ctx.ui.select = async () => "继续修改草稿";
	await f.command("edit", f.ctx);
	assert.equal(edits, 2);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), JSON.parse(valid));
	assert.equal(f.notices.filter((notice) => notice.type === "error").length, 1);
	assert.equal(f.notices.filter((notice) => notice.message.startsWith("已保存")).length, 1);
});

test("其他窗口修改发生冲突，不覆盖；用户主动读最新后才能保存", async (t) => {
	const f = commandFixture(t);
	let edits = 0;
	f.ctx.ui.editor = async (_title, draft) => {
		if (edits++ === 0) writeFileSync(f.path, '{"rules":[]}');
		else assert.deepEqual(JSON.parse(draft), { rules: [] });
		return '{"rules":[{"mode":"contains","pattern":"new"}]}';
	};
	f.ctx.ui.select = async () => {
		assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { rules: [] });
		return "放弃草稿并读取最新配置";
	};
	await f.command("edit", f.ctx);
	assert.ok(f.notices.some((notice) => notice.message.includes("其他窗口修改")));
	assert.equal(JSON.parse(readFileSync(f.path, "utf8")).rules[0].pattern, "new");
});

test("取消编辑不保存，非 UI 模式不打开编辑器，stop 调用标准 abort", async (t) => {
	const f = commandFixture(t);
	let aborts = 0;
	f.ctx.abort = () => { aborts++; };
	f.ctx.ui.editor = async () => undefined;
	await f.command("edit", f.ctx);
	assert.equal(f.notices.length, 0);
	f.ctx.hasUI = false;
	f.ctx.ui.editor = () => { throw new Error("不应打开编辑器"); };
	await f.command("edit", f.ctx);
	assert.ok(f.notices[0].message.includes("没有编辑器"));
	await f.command("stop", f.ctx);
	assert.equal(aborts, 1);
});

test("持久日志只恢复当前分支、provider 和策略的计数", () => {
	const rules = [{ mode: "contains", pattern: "retry-me" }];
	const key = policyKey(rules);
	const record = { kind: "retry", retry: 17, retryId: "chain", policyKey: key, provider: "p", model: "m" };
	const log = { type: "custom", customType: RECOVERY_ENTRY, data: record };
	const error = { type: "message", message: { role: "assistant", stopReason: "error" } };
	assert.deepEqual(previousRetry([log, error], key, "p", "m"), record);
	assert.equal(previousRetry([log, error], "changed", "p", "m"), undefined);
	assert.equal(previousRetry([log, error], key, "other", "m"), undefined);
	for (const boundary of [{ type: "message", message: { role: "assistant", stopReason: "length" } },
		{ type: "message", message: { role: "assistant", stopReason: "stop" } },
		{ type: "message", message: { role: "user" } }, { type: "custom_message" }]) {
		assert.equal(previousRetry([log, boundary, error], key, "p", "m"), undefined);
	}
	assert.equal(previousRetry([], key, "p", "m"), undefined);
});

test("已结束错误加载扩展不会自动唤醒；非法规则和正则超时不接管", (t) => {
	const f = commandFixture(t);
	const error = { role: "assistant", stopReason: "error", provider: "p", model: "m", errorMessage: `${"a".repeat(100000)}!` };
	const event = { outcome: "error", continue: false, context: { pendingMessages: [], contextEntries: [{ sourceEntry: { id: "failure" } }] } };
	const ctx = { ...f.ctx, hasPendingMessages: () => false, sessionManager: { getBranch: () => [] } };
	f.handlers.get("session_start")();
	assert.equal(f.handlers.get("agent_before_settle")(event, ctx), undefined);
	f.handlers.get("turn_end")({ message: error, messageEntryId: "failure" }, ctx);
	writeFileSync(f.path, '{"rules":[{"mode":"regex","pattern":"^(a+)+$"}]}');
	assert.equal(f.handlers.get("agent_before_settle")(event, ctx), undefined);
	assert.ok(f.notices[0].message.includes("timed out"));
	writeFileSync(f.path, "invalid JSON");
	assert.equal(f.handlers.get("agent_before_settle")(event, ctx), undefined);
	assert.equal(f.notices.length, 2);
});

test("导入 DSH 文件经用户确认后替换规则，支持相对路径及带空格的导出路径", async (t) => {
	const f = commandFixture(t);
	const incoming = { version: 1, rules: [{ mode: "regex", pattern: "^busy$", flags: "i" }] };
	writeFileSync(f.path, '{"rules":[]}');
	writeFileSync(join(f.directory, "dsh rules.json"), JSON.stringify(incoming));
	let confirmations = 0;
	f.ctx.ui.confirm = async (title, message, options) => {
		confirmations++;
		assert.equal(title, "导入错误重试规则");
		assert.ok(message.includes("导入 1 条规则，将替换当前 0 条规则"));
		assert.ok(message.includes("无限重试"));
		assert.equal(options.signal.aborted, false);
		assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { rules: [] });
		return true;
	};
	await f.command('import "dsh rules.json"', f.ctx);
	assert.equal(confirmations, 1);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { rules: incoming.rules });
	assert.ok(f.notices.some(notice => notice.message.startsWith("已导入 1 条规则")));
	const output = join(f.directory, "export rules.json");
	await f.command(`export '${output}'`, f.ctx);
	assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), incoming);
	assert.equal(confirmations, 1, "导出新文件不要求替换确认");
	assert.ok(f.notices.some(notice => notice.message.startsWith("已导出 1 条规则")));
});

test("导入原生对象及裸空数组，确认后才创建配置，不追加默认规则", async (t) => {
	for (const value of [{ rules: [] }, []]) {
		const f = commandFixture(t);
		const input = join(f.directory, "input.json");
		writeFileSync(input, JSON.stringify(value));
		f.ctx.ui.confirm = async () => true;
		await f.command(`import ${input}`, f.ctx);
		assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { rules: [] });
	}
});

test("取消导入或输入无效时不改配置，不显示导入成功", async (t) => {
	const f = commandFixture(t);
	const input = join(f.directory, "input.json");
	const before = '{"rules":[{"mode":"contains","pattern":"old"}]}';
	writeFileSync(f.path, before);
	writeFileSync(input, '{"rules":[]}');
	f.ctx.ui.confirm = async () => false;
	await f.command(`import ${input}`, f.ctx);
	assert.ok(f.notices.some(notice => notice.message.includes("已取消导入")));
	f.ctx.ui.confirm = async () => { throw new Error("无效规则不能进入确认"); };
	for (const text of ['{"version":2,"rules":[]}', '{"rules":[{"mode":"regex","pattern":"["}]}', "broken"]) {
		writeFileSync(input, text);
		await f.command(`import ${input}`, f.ctx);
	}
	await f.command(`import ${input}.missing`, f.ctx);
	assert.equal(readFileSync(f.path, "utf8"), before);
	assert.ok(!f.notices.some(notice => notice.message.startsWith("已导入")));
	assert.equal(f.notices.filter(notice => notice.type === "error").length, 4);
});

test("导入确认期间其他窗口修改配置，保存拒绝覆盖对方改动", async (t) => {
	const f = commandFixture(t);
	const input = join(f.directory, "input.json");
	writeFileSync(input, '{"rules":[]}');
	const other = '{"rules":[{"mode":"contains","pattern":"other-window"}]}';
	f.ctx.ui.confirm = async () => { writeFileSync(f.path, other); return true; };
	await f.command(`import ${input}`, f.ctx);
	assert.equal(readFileSync(f.path, "utf8"), other);
	assert.ok(f.notices.some(notice => notice.type === "error" && notice.message.includes("其他窗口修改")));
	assert.ok(!f.notices.some(notice => notice.message.startsWith("已导入")));
});

test("导入等待确认时会话关闭，忽略迟到确认且不修改配置", async (t) => {
	const f = commandFixture(t);
	const input = join(f.directory, "input.json");
	writeFileSync(f.path, '{"rules":[]}');
	writeFileSync(input, '{"rules":[{"mode":"contains","pattern":"new"}]}');
	let confirm;
	let signal;
	f.ctx.ui.confirm = async (_title, _message, options) => {
		signal = options.signal;
		return new Promise(resolve => { confirm = resolve; });
	};
	const pending = f.command(`import ${input}`, f.ctx);
	assert.equal(signal.aborted, false);
	f.handlers.get("session_shutdown")();
	assert.equal(signal.aborted, true);
	f.handlers.get("session_start")();
	confirm(true);
	await pending;
	assert.equal(readFileSync(f.path, "utf8"), '{"rules":[]}');
	assert.deepEqual(f.notices, []);
});

test("非 UI 导入不跳过确认，导出仍可用，但重复导出不覆盖文件", async (t) => {
	const f = commandFixture(t);
	const input = join(f.directory, "input.json");
	const output = join(f.directory, "output.json");
	writeFileSync(f.path, '{"rules":[]}');
	writeFileSync(input, '{"rules":[{"mode":"contains","pattern":"new"}]}');
	f.ctx.hasUI = false;
	f.ctx.ui.confirm = () => { throw new Error("非 UI 不能确认"); };
	await f.command(`import ${input}`, f.ctx);
	assert.equal(readFileSync(f.path, "utf8"), '{"rules":[]}');
	assert.ok(f.notices.some(notice => notice.message.includes("无法确认替换")));
	await f.command(`export ${output}`, f.ctx);
	assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { version: 1, rules: [] });
	const original = readFileSync(output, "utf8");
	await f.command(`export ${output}`, f.ctx);
	assert.equal(readFileSync(output, "utf8"), original);
	assert.equal(f.notices.filter(notice => notice.message.startsWith("已导出")).length, 1);
	assert.ok(f.notices.some(notice => notice.type === "error" && notice.message.includes("未覆盖")));
});

test("缺少文件路径、未知动作及 edit/stop 的额外参数只显示用法", async (t) => {
	const f = commandFixture(t);
	f.ctx.abort = () => { throw new Error("非法命令不能停止请求"); };
	for (const command of ["import", "export", "unknown", "edit extra", "stop extra"]) await f.command(command, f.ctx);
	assert.equal(f.notices.length, 5);
	assert.ok(f.notices.every(notice => notice.type === "warning" && notice.message.startsWith("用法：")));
});
