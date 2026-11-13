import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const background = JSON.parse(readFileSync(join(root, "pi-background-bash/package.json"), "utf8"));

function npm(args) {
  const cli = process.env.npm_execpath;
  const result = spawnSync(cli ? process.execPath : "npm", cli ? [cli, ...args] : args, {
    cwd: root, encoding: "utf8", timeout: 60000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
}

function expectedWeb() {
  const web = structuredClone(background.piWeb);
  const prefix = "pi-background-bash/";
  web.entry = prefix + web.entry;
  web.assets = web.assets.map(path => prefix + path);
  web.bridge.entry = prefix + web.bridge.entry;
  return web;
}

test("统一 Pi 入口与 workspace 子包入口一致，不捆绑宿主运行时依赖", () => {
  const entries = manifest.workspaces.flatMap(path => {
    const child = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
    return child.pi.extensions.map(entry => `./${path}/${entry.replace(/^\.\//, "")}`);
  });
  assert.deepEqual(manifest.pi.extensions, entries);
  assert.equal(entries.length, 2);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.peerDependencies.typebox, "*");
  for (const entry of entries) assert.ok(existsSync(join(root, entry)), entry);
});

test("统一 Web 清单只调整资源根路径，保留原生协议、权限和包身份", () => {
  assert.deepEqual(manifest.piWeb, expectedWeb());
  assert.ok(manifest.piWeb.assets.includes(manifest.piWeb.entry));
  assert.ok(!manifest.piWeb.assets.includes(manifest.piWeb.bridge.entry));
  for (const path of [...manifest.piWeb.assets, manifest.piWeb.bridge.entry]) {
    assert.ok(existsSync(join(root, path)), path);
    assert.ok(path.startsWith("pi-background-bash/web/"), path);
  }
  for (const permission of manifest.piWeb.bridge.permissions.events) {
    assert.equal(permission.package, background.name);
  }
});

test("统一 tarball 包含双端资源，真实 Pi 加载器可从包声明发现两个扩展", async t => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-extensions-shuyuan-package-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary]))[0];
  const files = new Set(packed.files.map(file => file.path));
  for (const path of [
    ...manifest.pi.extensions.map(path => path.replace(/^\.\//, "")),
    ...manifest.piWeb.assets, manifest.piWeb.bridge.entry,
    "pi-error-retry/src/config.ts", "pi-error-retry/src/rules.ts",
    "pi-error-retry/package.json", "pi-background-bash/package.json",
    "pi-background-bash/src/jobs.ts", "pi-background-bash/src/rpc.ts",
  ]) assert.ok(files.has(path), path);
  for (const path of files) {
    assert.ok(!/(^|\/)(node_modules|\.git|tests)(\/|$)/.test(path), path);
    assert.ok(!path.endsWith("package-lock.json"), path);
  }
  const extracted = spawnSync("tar", ["-xzf", join(temporary, packed.filename), "-C", temporary], { encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr);
  const packageRoot = join(temporary, "package");
  // 在隔离配置下只加载扩展工厂，不运行模型、命令或用户配置迁移。
  const loader = new DefaultResourceLoader({
    cwd: temporary, agentDir: join(temporary, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const extensions = result.extensions.filter(extension => extension.path.startsWith(packageRoot + "/"));
  assert.deepEqual(extensions.map(extension => extension.path).sort(),
    manifest.pi.extensions.map(path => resolve(packageRoot, path)).sort());
  assert.ok(extensions.some(extension => extension.commands.has("error-retry")));
  assert.ok(extensions.some(extension => extension.tools.has("bash_jobs")));
});
