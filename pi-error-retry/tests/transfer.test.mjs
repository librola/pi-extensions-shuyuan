import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readConfig, saveConfig } from "../src/config.ts";
import { DEFAULT_RULES } from "../src/rules.ts";
import { exportRulesFile, readRulesFile, resolveRulesFilePath } from "../src/transfer.ts";

function temporary(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-error-retry-transfer-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

const RULES = [{ mode: "contains", pattern: " 中文错误 " }, { mode: "regex", pattern: "^BUSY$", flags: "im" }];

test("导入兼容 DSH v1、原生配置和裸数组，保留规则内容与空数组", (t) => {
	const path = join(temporary(t), "rules.json");
	for (const value of [{ version: 1, rules: RULES }, { rules: RULES }, RULES, { version: 1, rules: [] }, []]) {
		writeFileSync(path, JSON.stringify(value));
		assert.deepEqual(readRulesFile(path), { rules: Array.isArray(value) ? value : value.rules });
	}
	writeFileSync(path, `\uFEFF${JSON.stringify({ version: 1, rules: RULES })}`);
	assert.deepEqual(readRulesFile(path), { rules: RULES });
});

test("导入拒绝缺失规则、未知版本、额外字段、非法 JSON 和非法规则", (t) => {
	const path = join(temporary(t), "rules.json");
	for (const value of [null, 1, "text", {}, { version: 1 }, { version: 2, rules: [] }, { version: "1", rules: [] },
		{ rules: null }, { rules: [], extra: true }, [null], [{ mode: "contains", pattern: " " }],
		[{ mode: "contains", pattern: "ok", flags: "i" }], [{ mode: "regex", pattern: "[" }],
		...['g', 'y', 'ii'].map(flags => [{ mode: "regex", pattern: "ok", flags }])]) {
		writeFileSync(path, JSON.stringify(value));
		assert.throws(() => readRulesFile(path), undefined, JSON.stringify(value));
	}
	for (const text of ["", " ", "{broken"]) {
		writeFileSync(path, text);
		assert.throws(() => readRulesFile(path), /JSON 解析失败/);
	}
	assert.throws(() => readRulesFile(path + ".missing"), /ENOENT/);
});

test("导入按字节限制 1 MiB，边界合法，目录和 FIFO 不进入阻塞读取", (t) => {
	const directory = temporary(t);
	const path = join(directory, "rules.json");
	writeFileSync(path, '{"rules":[]}'.padEnd(1024 * 1024, " "));
	assert.deepEqual(readRulesFile(path), { rules: [] });
	writeFileSync(path, "中".repeat(400000));
	assert.throws(() => readRulesFile(path), /超过 1 MiB/);
	assert.throws(() => readRulesFile(directory));
	if (process.platform !== "win32") {
		const fifo = join(directory, "fifo");
		assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
		assert.throws(() => readRulesFile(fifo), /普通 JSON 文件/);
	}
});

test("文件路径支持相对、绝对、空格、成对引号和 ~，不进行 shell 展开", (t) => {
	const directory = temporary(t);
	assert.equal(resolveRulesFilePath("  ./rules file.json  ", directory), join(directory, "rules file.json"));
	assert.equal(resolveRulesFilePath('"rules file.json"', directory), join(directory, "rules file.json"));
	assert.equal(resolveRulesFilePath("'rules file.json'", directory), join(directory, "rules file.json"));
	assert.equal(resolveRulesFilePath(join(directory, "file.json"), directory), join(directory, "file.json"));
	assert.equal(resolveRulesFilePath("~/rules.json", directory), join(homedir(), "rules.json"));
	assert.equal(resolveRulesFilePath("$HOME/*.json; echo nope", directory), join(directory, "$HOME/*.json; echo nope"));
	for (const path of ["", " ", '""', '"broken', "'broken\"", "file\0.json"]) {
		assert.throws(() => resolveRulesFilePath(path, directory));
	}
});

test("未创建用户配置时也能导出有效默认规则，但不创建用户配置", (t) => {
	const directory = temporary(t);
	const config = join(directory, "not-created", "config.json");
	const output = join(directory, "export.json");
	assert.deepEqual(exportRulesFile(config, output), { rules: DEFAULT_RULES });
	assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { version: 1, rules: DEFAULT_RULES });
	assert.deepEqual(readRulesFile(output), { rules: DEFAULT_RULES });
	assert.ok(!existsSync(config));
	assert.equal(statSync(output).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(directory), ["export.json"]);
});

test("导出当前有效规则为 DSH v1，补全 regex flags，不修改配置和规则", (t) => {
	const directory = temporary(t);
	const config = join(directory, "config.json");
	const rules = [...RULES, { mode: "regex", pattern: "no flags" }];
	saveConfig(config, { rules }, null);
	const before = readFileSync(config, "utf8");
	const output = join(directory, "export.json");
	assert.deepEqual(exportRulesFile(config, output), { rules });
	assert.equal(readFileSync(config, "utf8"), before);
	const expected = [...RULES, { mode: "regex", pattern: "no flags", flags: "" }];
	assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { version: 1, rules: expected });
	assert.deepEqual(readRulesFile(output), { rules: expected });
	assert.equal(rules[2].flags, undefined);
});

test("导出拒绝覆盖已有文件、目录及符号链接，失败后清理临时文件", (t) => {
	const directory = temporary(t);
	const config = join(directory, "config.json");
	saveConfig(config, { rules: RULES }, null);
	const file = join(directory, "existing.json");
	const folder = join(directory, "folder");
	const alias = join(directory, "alias.json");
	writeFileSync(file, "keep-me");
	mkdirSync(folder);
	symlinkSync(file, alias);
	const before = readdirSync(directory).sort();
	for (const destination of [file, folder, alias]) assert.throws(() => exportRulesFile(config, destination), /未覆盖/);
	assert.equal(readFileSync(file, "utf8"), "keep-me");
	assert.deepEqual(readConfig(config).config, { rules: RULES });
	assert.deepEqual(readdirSync(directory).sort(), before);
});

test("配置文件不存在时也禁止导出到原配置路径及目录符号链接别名", (t) => {
	const directory = temporary(t);
	const config = join(directory, "config.json");
	const alias = join(directory, "alias");
	symlinkSync(directory, alias, "dir");
	assert.throws(() => exportRulesFile(config, config), /正在使用的配置文件/);
	assert.throws(() => exportRulesFile(config, join(alias, "config.json")), /正在使用的配置文件/);
	assert.ok(!existsSync(config));
	assert.deepEqual(readdirSync(directory), ["alias"]);
});

test("无效当前配置、缺失目标目录和超大导出均不留下输出文件", (t) => {
	const directory = temporary(t);
	const config = join(directory, "config.json");
	const output = join(directory, "export.json");
	writeFileSync(config, "broken");
	assert.throws(() => exportRulesFile(config, output));
	writeFileSync(config, JSON.stringify({ rules: [] }));
	assert.throws(() => exportRulesFile(config, join(directory, "missing", "export.json")), /ENOENT/);
	writeFileSync(config, JSON.stringify({ rules: [{ mode: "contains", pattern: "x".repeat(1024 * 1024) }] }));
	assert.throws(() => exportRulesFile(config, output), /超过 1 MiB/);
	assert.deepEqual(readdirSync(directory), ["config.json"]);
});

test("导出写入中途失败会关闭描述符并清理部分临时文件", (t) => {
	const directory = temporary(t);
	const config = join(directory, "config.json");
	const output = join(directory, "export.json");
	const original = fs.writeFileSync;
	t.mock.method(fs, "writeFileSync", (file, text) => {
		original(file, text.slice(0, 1));
		throw new Error("模拟磁盘写入失败");
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => exportRulesFile(config, output), /模拟磁盘写入失败/);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
	assert.deepEqual(readdirSync(directory), []);
});

test("导出发布前目标被其他进程创建时保留对方文件", (t) => {
	const directory = temporary(t);
	const config = join(directory, "config.json");
	const output = join(directory, "export.json");
	const original = fs.linkSync;
	t.mock.method(fs, "linkSync", (source, destination) => {
		writeFileSync(destination, "other-process");
		return original(source, destination);
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => exportRulesFile(config, output), /未覆盖/);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
	assert.equal(readFileSync(output, "utf8"), "other-process");
	assert.deepEqual(readdirSync(directory), ["export.json"]);
});
