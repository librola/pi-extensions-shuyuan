import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { hostPath } from "../tests/host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 按模块解析查找开发依赖，同时支持独立安装和 workspace 的依赖提升。
const require = createRequire(import.meta.url);
const typescript = require.resolve("typescript/bin/tsc");
const typeRoots = dirname(dirname(require.resolve("@types/node/package.json")));
const temporary = mkdtempSync(join(tmpdir(), "pi-error-retry-check-"));
try {
	const path = join(temporary, "tsconfig.json");
	writeFileSync(path, JSON.stringify({
		extends: join(root, "tsconfig.json"),
		compilerOptions: {
			baseUrl: root,
			typeRoots: [typeRoots],
			paths: { "@earendil-works/pi-coding-agent": [hostPath.replace(/\.js$/, ".d.ts")] },
		},
	}));
	const result = spawnSync(process.execPath, [typescript, "-p", path], {
		cwd: root, stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
