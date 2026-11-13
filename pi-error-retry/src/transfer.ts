import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readConfig } from "./config.ts";
import { type RetryConfig, validateConfig } from "./rules.ts";

const MAX_RULES_FILE_BYTES = 1024 * 1024;

/** 将命令剩余参数作为一个路径，不执行 shell 或展开环境变量。 */
export function resolveRulesFilePath(argument: string, cwd: string): string {
	let path = argument.trim();
	if (path.startsWith('"') || path.startsWith("'")) {
		if (path.length < 2 || path.at(-1) !== path[0]) throw new Error("文件路径的引号必须成对");
		path = path.slice(1, -1);
	}
	if (!path.trim() || path.includes("\0")) throw new Error("请提供有效的 JSON 文件路径");
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	return resolve(cwd, path);
}

/** 读取 DSH v1、原生配置对象或裸规则数组，统一使用现有规则校验。 */
export function readRulesFile(path: string): RetryConfig {
	// 非阻塞打开后检查同一个描述符，拒绝 FIFO、设备等可能让命令一直等待的输入。
	const file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	let text: string;
	try {
		const stat = fstatSync(file);
		if (!stat.isFile()) throw new Error("导入路径必须是普通 JSON 文件");
		if (stat.size > MAX_RULES_FILE_BYTES) throw new Error("规则文件过大（超过 1 MiB）");
		// 读取上限不依赖最初的 stat，文件并发增长也不会无限分配内存。
		const buffer = Buffer.alloc(MAX_RULES_FILE_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const count = readSync(file, buffer, size, buffer.length - size, null);
			if (count === 0) break;
			size += count;
		}
		if (size > MAX_RULES_FILE_BYTES) throw new Error("规则文件过大（超过 1 MiB）");
		text = buffer.subarray(0, size).toString("utf8").replace(/^\uFEFF/, "");
	} finally {
		closeSync(file);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
	}
	if (Array.isArray(value)) return validateConfig({ rules: value });
	if (!value || typeof value !== "object") throw new Error("规则文件必须包含 rules 数组或直接提供规则数组");
	const object = value as Record<string, unknown>;
	if (Object.keys(object).some((key) => key !== "version" && key !== "rules")) {
		throw new Error("规则文件仅接受 version、rules 字段");
	}
	if (object.version !== undefined && object.version !== 1) throw new Error("不支持的规则文件版本，仅支持 version: 1");
	// 导入缺少 rules 的文件不能意外启用默认规则；用户配置读取的旧行为不变。
	if (!Array.isArray(object.rules)) throw new Error("规则文件必须包含 rules 数组");
	return validateConfig({ rules: object.rules });
}

/** 导出当前有效规则为 DSH v1 文件，原子创建新文件，绝不覆盖已有目标。 */
export function exportRulesFile(configPath: string, destination: string): RetryConfig {
	const config = readConfig(configPath).config;
	const target = join(realpathSync(dirname(destination)), basename(destination));
	let active = resolve(configPath);
	try {
		active = join(realpathSync(dirname(active)), basename(active));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (target === active) throw new Error("不能导出到正在使用的配置文件，请选择其他路径");
	const rules = config.rules.map((rule) => rule.mode === "regex" ? { ...rule, flags: rule.flags ?? "" } : { ...rule });
	const text = `${JSON.stringify({ version: 1, rules }, null, 2)}\n`;
	if (Buffer.byteLength(text) > MAX_RULES_FILE_BYTES) throw new Error("导出规则文件过大（超过 1 MiB）");
	const temporary = `${target}.${randomUUID()}.tmp`;
	const file = openSync(temporary, "wx", 0o600);
	try {
		try {
			writeFileSync(file, text);
		} finally {
			closeSync(file);
		}
		// 同目录硬链接一次发布完整内容；目标在检查后被创建也不会被覆盖。
		try {
			linkSync(temporary, target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`导出目标已存在，未覆盖：${destination}`);
			throw error;
		}
	} finally {
		unlinkSync(temporary);
	}
	return config;
}
