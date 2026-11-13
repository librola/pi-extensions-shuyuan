import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// 使用已安装 tarball、真实 fork 和原生扩展；所有模型回复来自隔离的本地假 provider。
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = process.env.PI_WEB_PROJECT;
if (!project || !existsSync(join(project, "lib/web-extension-types.ts"))) throw new Error("Set PI_WEB_PROJECT to the extension-focused Pi Web checkout");
const port = Number(process.env.PI_WEB_E2E_PORT ?? 30141);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid PI_WEB_E2E_PORT");
const base = `http://127.0.0.1:${port}`;
if (existsSync(join(project, ".next/dev/lock"))) throw new Error("The checkout already has a Next dev lock; stop that test server first");
try { await fetch(base, { signal: AbortSignal.timeout(1000) }); throw new Error(`Port ${port} is occupied; this test requires an idle checkout`); }
catch (error) { if (!String(error).includes("fetch failed")) throw error; }

const root = mkdtempSync(join(tmpdir(), "pi-background-bash-web-"));
const evidence = mkdtempSync(join(tmpdir(), "pi-background-bash-evidence-"));
const agentDir = join(root, "agent");
const cwd = join(root, "workspace");
mkdirSync(agentDir); mkdirSync(cwd);
// npm run 提供其真实 CLI 路径；直接执行脚本时再使用 Node 安装目录的 npm。
const cli = process.env.npm_execpath ?? resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
if (!existsSync(cli)) throw new Error("Cannot find bundled npm CLI");
function npm(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: plugin, encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", root]))[0];
const prefix = join(root, "installed");
npm(["install", "--prefix", prefix, "--ignore-scripts", "--legacy-peer-deps", "--omit=dev", "--no-audit", "--no-fund", join(root, packed.filename)]);
const installed = join(prefix, "node_modules", "pi-background-bash");
assert.ok(existsSync(join(installed, "web/browser.js")));
assert.ok(existsSync(join(installed, "src/rpc.ts")));
// 新计数仅复用 v1 list；模拟已有 0.2.0 原生实例，证明无需为 Web 更新重启任务。
const nativeRpc = join(installed, "src/rpc.ts");
writeFileSync(nativeRpc, readFileSync(nativeRpc, "utf8").replace(/PACKAGE_VERSION = "0\.2\.\d+"/, 'PACKAGE_VERSION = "0.2.0"'));
const provider = join(root, "offline-provider.mjs");
writeFileSync(provider, `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  pi.registerProvider("pbb-test", {
    api: "pbb-fixture", baseUrl: "http://127.0.0.1", apiKey: "not-a-real-key",
    models: [{ id: "offline", name: "Offline PBB test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const index = context.messages.findLastIndex(message => message.role === "user");
      const user = context.messages[index];
      const text = typeof user?.content === "string" ? user.content : (user?.content || []).filter(block => block.type === "text").map(block => block.text).join(" ");
      const seen = context.messages.slice(index + 1).some(message => message.role === "toolResult");
      const commands = {
        BACKGROUND_TEST: { command: "printf 'background-start\\n'; sleep 60; printf 'background-end\\n'", background: true, hard_timeout: 150 },
        FOREGROUND_TEST: { command: "printf 'foreground-start\\n'; sleep 60; printf 'foreground-end\\n'", timeout: 120, hard_timeout: 150 },
        COMPLETE_TEST: { command: "printf 'web-done\\n'; sleep 0.15; printf 'safe <img src=x onerror=alert(1)> output\\n'", background: true }
      };
      const input = !seen ? commands[text] : undefined;
      const message = { role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason: input ? "toolUse" : "stop", content: input ? [{ type: "toolCall", id: "pbb-" + Date.now(), name: "bash", arguments: input }] : [{ type: "text", text: "离线测试回复。" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      setTimeout(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); }, input ? 0 : 100);
      return stream;
    }
  });
}`);
const settings = packages => writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
  packages, extensions: [provider], defaultProvider: "pbb-test", defaultModel: "offline", cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
}));
settings([installed]);
const first = SessionManager.create(cwd, join(agentDir, "sessions", "fixture"));
first.appendModelChange("pbb-test", "offline");
first.appendMessage({ role: "user", content: "测试会话一", timestamp: Date.now() });
first.appendSessionInfo("PBB first");
const second = SessionManager.create(cwd, join(agentDir, "sessions", "fixture"));
second.appendModelChange("pbb-test", "offline");
second.appendMessage({ role: "user", content: "测试会话二", timestamp: Date.now() });
second.appendSessionInfo("PBB second");

// 测试子进程的网络守卫不进入插件；外网 fetch 失败，本地 HTTP 和 HMR 仍可工作。
const guard = join(root, "network-guard.mjs");
writeFileSync(guard, `const original = globalThis.fetch; globalThis.fetch = (input, options) => { const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return Promise.reject(new Error("External network disabled in PBB test")); return original(input, options); };`);
const server = spawn(process.execPath, ["--import", guard, join(project, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", PI_WEB_DISABLE_MCP: "1" },
  stdio: ["ignore", "pipe", "pipe"], detached: true,
});
let log = "";
for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { log += chunk; });
let browser;
let page;
const diagnostics = [];
async function wait(predicate, timeout = 60000) {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error("Browser test condition timed out");
    if (server.exitCode !== null) throw new Error("Pi Web test server exited");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function json(path, body) {
  const response = await fetch(base + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}
const catalog = async () => (await json("/api/web-extensions")).extensions.find(item => item.id === "pi-background-bash");
async function action(owner, name, input = {}) {
  const descriptor = await catalog();
  return (await json("/api/web-extensions/action", { extensionId: descriptor.id, revision: descriptor.revision, ownerSessionId: owner, action: name, input })).result;
}
async function idle(owner) { await wait(async () => !(await json("/api/agent/running")).runningSessionIds.includes(owner)); }
const leaf = () => JSON.parse(readFileSync(first.getSessionFile(), "utf8").trim().split("\n").at(-1)).id;
try {
  await wait(async () => { try { return (await fetch(base + "/api/web-extensions")).ok; } catch { return false; } });
  const descriptor = await catalog();
  assert.ok(descriptor, "已安装双端包被 fork 自动发现");
  for (const asset of ["src/index.ts", "web/bridge.mjs", "package.json"]) assert.ok([400, 404].includes((await fetch(base + descriptor.assetBaseUrl + asset)).status), "原生源代码、桥和 manifest 不公开");
  // 容器没有可用 GPU，显式使用 CPU 合成，避免 headless 的 RAF/截图停滞。
  browser = await chromium.launch({ headless: true, args: ["--disable-gpu", "--disable-software-rasterizer"] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  await context.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); diagnostics.push("pageerror: " + error.stack); });
  page.on("console", message => { if (message.type() === "error") diagnostics.push("console: " + message.text()); });
  page.on("requestfailed", request => diagnostics.push("requestfailed: " + request.url() + " " + request.failure()?.errorText));
  page.on("crash", () => diagnostics.push("Page crashed"));
  const requests = [];
  const agentStops = [];
  const prompts = [];
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/web-extensions/action") requests.push(request.postDataJSON());
    if (request.method() === "POST" && /\/api\/agent\/[^/]+$/.test(pathname)) {
      const body = request.postDataJSON();
      if (body?.type === "abort" || body?.type === "abort_bash") agentStops.push(body);
      if (body?.type === "prompt") prompts.push(body);
    }
  });
  const open = async () => { await page.getByRole("button", { name: "后台任务", exact: true }).click(); return page.getByRole("dialog", { name: "后台 Bash 任务", exact: true }); };
  const countRequests = () => requests.filter(request => request.action === "count").length;
  const expectCount = value => wait(async () => await page.locator(`.pbb-count[data-running="${value}"]`).count() === 1);
  const send = async text => {
    const replies = await page.getByText("离线测试回复。", { exact: true }).count();
    const accepted = page.waitForRequest(request => {
      if (request.method() !== "POST" || !/\/api\/agent\/[^/]+$/.test(new URL(request.url()).pathname)) return false;
      const body = request.postDataJSON();
      return body?.type === "prompt" && body.message === text;
    });
    const input = page.locator(".chat-input-textarea");
    await input.fill(text); await input.press("Enter"); await accepted;
    if (text !== "FOREGROUND_TEST") await wait(async () => await page.getByText("离线测试回复。", { exact: true }).count() > replies);
    else await wait(async () => {
      try { return (await action(first.getSessionId(), "list")).jobs.some(job => job.command.includes("foreground-start") && job.status === "running"); }
      catch { return false; }
    });
  };
  await page.goto(base + "/?cwd=" + encodeURIComponent(cwd));
  await page.getByRole("button", { name: "后台任务", exact: true }).waitFor({ timeout: 60000 });
  const beforeWrappers = (await json("/api/agent/debug")).server.wrappers.length;
  let panel = await open();
  await panel.getByText("请选择一个会话。", { exact: true }).waitFor();
  assert.equal(requests.length, 0, "无会话时展开下拉框不执行桥动作");
  assert.equal(await page.locator(".pbb-count").count(), 0, "没有实例时不显示假 0");
  assert.equal((await json("/api/agent/debug")).server.wrappers.length, beforeWrappers);
  assert.equal(await page.locator(".web-extension-sidebar").getByRole("button", { name: "后台 Bash 任务", exact: true }).count(), 0, "不注册侧栏面板");
  const composeWidth = (await page.locator(".chat-input-textarea").boundingBox()).width;
  await page.locator(".chat-input-textarea").click();
  await panel.waitFor({ state: "hidden" });
  assert.equal((await page.locator(".chat-input-textarea").boundingBox()).width, composeWidth, "下拉框不改变聊天区域宽度");
  await page.locator(".chat-input-textarea").fill("/bash-jobs");
  await page.locator(".chat-input-textarea").press("Enter");
  await panel.waitFor();
  assert.equal(prompts.length, 0, "Web 命令只展开下拉框，不发送模型提示");
  assert.equal(requests.length, 0);
  await panel.getByRole("button", { name: "收起后台任务", exact: true }).click();

  await page.goto(base + "/?session=" + first.getSessionId());
  await send("BACKGROUND_TEST");
  await idle(first.getSessionId());
  await expectCount(1);
  assert.equal(await page.getByRole("button", { name: "后台任务", exact: true }).getAttribute("aria-expanded"), "false", "不展开就显示后台运行数量");
  await page.getByRole("button", { name: "后台任务", exact: true }).screenshot({ path: join(evidence, "toolbar-running.png") });
  panel = await open();
  const toolsBox = await page.getByRole("button", { name: "Tool definitions", exact: true }).boundingBox();
  const dropdownBox = await page.getByRole("button", { name: "后台任务", exact: true }).boundingBox();
  assert.ok(dropdownBox.x >= toolsBox.x + toolsBox.width - 1 && Math.abs(dropdownBox.y - toolsBox.y) < 3, "下拉入口在工具按钮之后的同一行");
  assert.ok((await panel.boundingBox()).y >= dropdownBox.y + dropdownBox.height, "下拉框在按钮下方");
  const beforeQuery = leaf();
  await panel.getByRole("button", { name: "刷新任务", exact: true }).click();
  await panel.locator(".pbb-job").filter({ hasText: "background-start" }).waitFor();
  const background = (await action(first.getSessionId(), "list")).jobs.find(job => job.command.includes("background-start") && job.status === "running");
  assert.ok(background);
  await panel.locator(`[data-job-id="${background.id}"] .pbb-job-select`).click();
  await panel.locator('[data-pbb="output"]').filter({ hasText: "background-start" }).waitFor();
  assert.equal(leaf(), beforeQuery, "浏览器查询不写模型上下文");
  await panel.getByRole("button", { name: "开启实时刷新", exact: true }).click();
  await page.waitForTimeout(2200);
  await panel.getByRole("button", { name: "收起后台任务", exact: true }).click();
  await page.waitForTimeout(300);
  const closedDetails = requests.filter(request => request.action !== "count").length;
  const closedCounts = countRequests();
  const closedLeaf = leaf();
  await page.waitForTimeout(2300);
  assert.equal(requests.filter(request => request.action !== "count").length, closedDetails, "收起后不轮询详细状态或输出");
  assert.ok(countRequests() > closedCounts, "收起后仍更新顶部数量");
  assert.equal(leaf(), closedLeaf, "顶部自动计数不写模型上下文");
  await expectCount(1);
  assert.equal((await action(first.getSessionId(), "status", { id: background.id })).job.status, "running");

  // 页面隐藏后暂停数量请求，恢复可见立即更新，而不是等待下一次定时器。
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  const hiddenCounts = countRequests();
  await page.waitForTimeout(2300);
  assert.equal(countRequests(), hiddenCounts, "隐藏页面不轮询顶部计数");
  await page.evaluate(() => { Reflect.deleteProperty(document, "hidden"); document.dispatchEvent(new Event("visibilitychange")); });
  await wait(() => countRequests() > hiddenCounts);

  // 缓慢响应期间仍只有一条当前视图的计数请求；不因下一轮定时器堆积查询。
  let releaseCount;
  const countGate = new Promise(resolve => { releaseCount = resolve; });
  let heldCount = false;
  const slowCount = async route => {
    if (route.request().postDataJSON()?.action === "count") { heldCount = true; await countGate; }
    await route.continue();
  };
  const beforeSlowCount = countRequests();
  await context.route("**/api/web-extensions/action", slowCount);
  try {
    await wait(() => heldCount);
    await page.waitForTimeout(2300);
    assert.equal(countRequests(), beforeSlowCount + 1, "计数查询不重叠");
  } finally { releaseCount(); await context.unroute("**/api/web-extensions/action", slowCount); }

  await page.goto(base + "/?session=" + second.getSessionId());
  panel = await open();
  await panel.getByRole("button", { name: "刷新任务", exact: true }).click();
  await panel.getByText("没有可展示的任务。", { exact: true }).waitFor();
  await expectCount(0);
  await assert.rejects(action(second.getSessionId(), "stop", { id: background.id }), /Extension action failed or unavailable/);
  await page.goto(base + "/?session=" + first.getSessionId());
  panel = await open();
  await panel.getByRole("button", { name: "刷新任务", exact: true }).click();
  const row = panel.locator(`[data-job-id="${background.id}"]`);
  await row.getByRole("button", { name: "停止任务", exact: true }).click();
  await panel.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
  assert.equal((await action(first.getSessionId(), "status", { id: background.id })).job.status, "running");
  await row.getByRole("button", { name: "停止任务", exact: true }).click();
  await panel.getByRole("button", { name: "确认停止", exact: true }).click();
  await row.getByText(/已停止/).waitFor();
  await panel.getByRole("button", { name: "收起后台任务", exact: true }).click();
  await idle(first.getSessionId());

  await send("FOREGROUND_TEST");
  await expectCount(0);
  panel = await open();
  await panel.getByRole("button", { name: "刷新任务", exact: true }).click();
  const foregroundRow = panel.locator(".pbb-job").filter({ hasText: "foreground-start" });
  const foregroundBefore = (await action(first.getSessionId(), "list")).jobs.find(job => job.command.includes("foreground-start") && job.status === "running");
  const stopsBefore = agentStops.length;
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  assert.equal(agentStops.length, stopsBefore, "Escape 只收起下拉，不停止主 agent");
  assert.equal((await action(first.getSessionId(), "status", { id: foregroundBefore.id })).job.status, "running");
  panel = await open();
  await panel.getByRole("button", { name: "刷新任务", exact: true }).click();
  await foregroundRow.getByRole("button", { name: "转入后台", exact: true }).click();
  await panel.getByRole("button", { name: "确认移交", exact: true }).click();
  await foregroundRow.getByRole("button", { name: "转入后台", exact: true }).waitFor({ state: "hidden" });
  const foreground = (await action(first.getSessionId(), "list")).jobs.find(job => job.command.includes("foreground-start"));
  assert.equal(foreground.background, true);
  await expectCount(1);
  assert.equal((await action(first.getSessionId(), "output", { id: foreground.id })).output.trim(), "foreground-start");
  await idle(first.getSessionId());
  // 确认式 GUI 停止已在前一任务覆盖，这里直接清理已验证移交的测试进程。
  assert.equal((await action(first.getSessionId(), "stop", { id: foreground.id })).job.status, "stopped");
  await expectCount(0);
  await panel.getByRole("button", { name: "收起后台任务", exact: true }).click();
  await idle(first.getSessionId());
  await send("COMPLETE_TEST");
  await wait(async () => (await action(first.getSessionId(), "list")).jobs.some(job => job.command.includes("web-done") && job.status === "completed"));
  await idle(first.getSessionId());
  // 原生聊天会折叠过程记录，重载后展开它们，验证持久化完成消息的专用渲染。
  await page.reload();
  await page.getByRole("button", { name: "后台任务", exact: true }).waitFor();
  for (const details of await page.getByRole("button", { name: /^Process details/ }).all()) {
    if (await details.getAttribute("aria-expanded") === "false") await details.click();
  }
  const completed = (await action(first.getSessionId(), "list")).jobs.find(job => job.command.includes("web-done") && job.status === "completed");
  await page.locator('[data-pbb="completion"]').filter({ hasText: completed.id }).waitFor();
  assert.equal(await page.getByRole("button", { name: "查看后台任务", exact: true }).count(), 0, "工具和完成输出不添加重复的顶栏弹出按钮");
  panel = await open();
  await panel.getByRole("button", { name: "刷新任务", exact: true }).click();
  const completeRow = panel.locator(".pbb-job").filter({ hasText: "web-done" });
  await completeRow.locator(".pbb-job-select").click();
  await panel.locator('[data-pbb="output"]').filter({ hasText: "safe <img" }).waitFor();
  assert.equal(await panel.locator('[data-pbb="output"] img').count(), 0, "输出只作为文本，不执行 HTML");
  await page.screenshot({ path: join(evidence, "desktop.png"), animations: "disabled" });
  await panel.getByRole("button", { name: "收起后台任务", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-mobile-toolbar-more="true"]').click();
  panel = await open();
  await panel.getByRole("button", { name: "刷新任务", exact: true }).click();
  await panel.locator(".pbb-job").filter({ hasText: "web-done" }).locator(".pbb-job-select").click();
  await panel.locator('[data-pbb="output"]').filter({ hasText: "web-done" }).waitFor();
  await page.screenshot({ path: join(evidence, "mobile.png"), animations: "disabled" });
  assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 2), "窄屏下拉框不横向溢出");
  const mobileBox = await panel.boundingBox();
  assert.ok(mobileBox.x >= 0 && mobileBox.x + mobileBox.width <= 390 && mobileBox.y + mobileBox.height <= 844, "下拉框不超出手机视口");
  await panel.getByRole("button", { name: "收起后台任务", exact: true }).click();
  await page.setViewportSize({ width: 1400, height: 1000 });

  // 已安装浏览器资源更新触发重载，但不重建 Next 或重新加载原生引擎。
  const browserPath = join(installed, "web/dropdown.js");
  const original = readFileSync(browserPath, "utf8");
  const oldDescriptor = await catalog();
  writeFileSync(browserPath, original.replaceAll('"后台 Bash 任务"', '"后台 Bash 任务（更新）"'));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await wait(async () => !(await page.locator('link[href*="' + oldDescriptor.revision + '"]').count()));
  await page.getByRole("button", { name: "后台任务", exact: true }).click();
  const updated = page.getByRole("dialog", { name: "后台 Bash 任务（更新）", exact: true });
  await updated.waitFor();
  assert.equal((await fetch(base + oldDescriptor.assetBaseUrl + "web/browser.js")).status, 409);
  await updated.getByRole("button", { name: "收起后台任务", exact: true }).click();
  const updatedDescriptor = await catalog();
  writeFileSync(browserPath, original);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await wait(async () => !(await page.locator('link[href*="' + updatedDescriptor.revision + '"]').count()));
  panel = await open();
  await panel.waitFor();
  await panel.getByRole("button", { name: "收起后台任务", exact: true }).click();

  // 模拟仅禁用 Web 展示，原生包及其任务不受影响。
  await send("BACKGROUND_TEST");
  await idle(first.getSessionId());
  await expectCount(1);
  writeFileSync(join(agentDir, "web-extensions.json"), JSON.stringify({ version: 1, extensions: [{ id: "pi-background-bash", enabled: false }] }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "后台任务", exact: true }).waitFor({ state: "hidden" });
  await page.getByText("bash jobs: 1", { exact: true }).first().waitFor();
  assert.equal(await page.locator('link[href*="web/style.css"]').count(), 0);
  const disabledCounts = countRequests();
  await page.waitForTimeout(2300);
  assert.equal(countRequests(), disabledCounts, "禁用 Web 后释放顶部计数轮询");
  writeFileSync(join(agentDir, "web-extensions.json"), JSON.stringify({ version: 1, extensions: [] }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "后台任务", exact: true }).waitFor();
  for (const job of (await action(first.getSessionId(), "list")).jobs) if (job.status === "running") await action(first.getSessionId(), "stop", { id: job.id });
  await idle(first.getSessionId());

  // 原生目标缺失时保留独立 Web 展示，操作明确失败，不回落为模型提示。
  settings([]);
  writeFileSync(join(agentDir, "web-extensions.json"), JSON.stringify({ version: 1, extensions: [{ path: installed, enabled: true }] }));
  await json("/api/agent/" + first.getSessionId(), { type: "reload" });
  await page.reload();
  panel = await open();
  await panel.getByText("当前会话未加载兼容的 pi-background-bash。原生 /reload 后重新展开下拉框。", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "刷新任务", exact: true }).isDisabled(), true);
  await page.waitForTimeout(2300);
  assert.equal(await page.locator(".pbb-count").count(), 0, "目标缺失时不把历史 running 或未知状态算为 0");
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, "verification.json"), JSON.stringify({ status: "passed", model: "offline local provider", installedTarball: packed.filename, tests: ["automatic discovery", "no-owner reads", "toolbar placement", "outside click", "escape isolation", "Web command", "live output", "query purity", "closed toolbar count", "count query purity", "hidden count pause", "count coalescing", "foreground excluded", "poll cleanup", "session isolation", "confirmed stop", "foreground handoff", "completion renderer", "text-only logs", "mobile", "asset update", "web-only disable", "missing target"] }, null, 2));
  console.log("Web adaptation E2E passed. Evidence:", evidence);
} catch (error) {
  writeFileSync(join(evidence, "browser.log"), diagnostics.join("\n"));
  console.error(diagnostics.join("\n"));
  if (page) {
    await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
    writeFileSync(join(evidence, "page.txt"), await page.locator("body").innerText().catch(() => ""));
  }
  console.error("Web test evidence:", evidence);
  throw error;
} finally {
  writeFileSync(join(evidence, "server.log"), log);
  await browser?.close();
  const exited = new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", resolve); });
  try { process.kill(-server.pid, "SIGTERM"); } catch { }
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (server.exitCode === null) { try { process.kill(-server.pid, "SIGKILL"); } catch { } }
  rmSync(root, { recursive: true, force: true });
}
