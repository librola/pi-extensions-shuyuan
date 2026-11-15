import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ExtensionContext, ExtensionUIContext, KeybindingsManager as AgentKeys, Theme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager, matchesKey, Key, TUI_KEYBINDINGS, TuiAltScreen, TuiMainScreen, visibleWidth,
  type Component, type OverlayHandle, type Terminal,
} from "@earendil-works/pi-tui";
import { createTuiJobsUi, TUI_JOBS_SHORTCUT } from "../src/tui-jobs.ts";
import type { JobSnapshot } from "../src/jobs.ts";
import { harness, until } from "./helpers.ts";

function object(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === "object");
  return value as Record<string, any>;
}

class TestTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  writes: string[] = [];
  input: ((data: string) => void) | undefined;
  resize: (() => void) | undefined;
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() { this.input = undefined; this.resize = undefined; }
  async drainInput() {}
  write(data: string) { this.writes.push(data); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}

function uiHarness(fullscreen = true) {
  const terminal = new TestTerminal();
  const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const widgets = new Map<string, Component>();
  const panels: Array<Component & { dispose?(): void }> = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  let customCalls = 0;
  const ui = {
    setStatus: (_key: string, text?: string) => statuses.push(text),
    setFooter: () => { throw new Error("The jobs UI must not replace the footer"); },
    notify: (text: string) => notifications.push(text),
    setWidget: (key: string, factory: ((view: typeof tui, theme: Theme) => Component) | undefined, options?: { placement?: string }) => {
      assert.equal(options?.placement ?? "belowEditor", "belowEditor");
      const old = widgets.get(key);
      if (old) tui.removeChild(old);
      widgets.delete(key);
      if (factory) { const widget = factory(tui, theme); widgets.set(key, widget); tui.addChild(widget); }
      tui.requestRender();
    },
    custom: (factory: Parameters<ExtensionUIContext["custom"]>[0], options: Parameters<ExtensionUIContext["custom"]>[1]) => {
      customCalls++;
      assert.equal(options?.overlay, true);
      // 用真实 TUI 的弹层和输入分发模拟宿主公开 custom() 的焦点与完成生命周期。
      return new Promise<void>((resolve, reject) => {
        let panel: Component & { dispose?(): void };
        let handle: OverlayHandle | undefined;
        let closed = false;
        const done = () => { if (closed) return; closed = true; handle?.hide(); panel?.dispose?.(); resolve(); };
        Promise.resolve(factory(tui, theme, keys as unknown as AgentKeys, done)).then(component => {
          if (closed) { component.dispose?.(); return; }
          panel = component; panels.push(panel);
          const overlayOptions = typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
          handle = tui.showOverlay(panel, overlayOptions);
        }).catch(reject);
      });
    },
  } as unknown as ExtensionUIContext;
  const ctx = { mode: "tui", hasUI: true, ui } as ExtensionContext;
  return { terminal, tui, ui, ctx, widgets, panels, notifications, statuses, get customCalls() { return customCalls; } };
}

function jobs(count = 1): JobSnapshot[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `job-${index.toString(16).padStart(8, "0")}`, command: `printf task-${index}`, cwd: "/tmp",
    status: "running", background: true, started_at: Date.now() - 5000, output_path: `/tmp/job-${index}.log`, output_bytes: 0,
  }));
}

test("CLI 摘要只计后台运行任务，完成记录仍可查看，不覆盖 footer", t => {
  const e = uiHarness();
  let snapshots = jobs(3);
  snapshots[1]!.background = false;
  snapshots[2]!.status = "completed";
  const view = createTuiJobsUi(e.ctx, () => snapshots);
  t.after(() => { view.dispose(); e.tui.stop(); });
  view.refresh();
  const widget = e.widgets.get("pi-background-bash")!;
  assert.match(widget.render(80).join("\n"), /Bash jobs: 1 running/);
  view.refresh();
  assert.equal(e.widgets.get("pi-background-bash"), widget);
  snapshots[0]!.status = "completed";
  view.refresh();
  assert.match(widget.render(80).join("\n"), /Bash jobs: 0 running/);
  for (const width of [12, 28, 40]) assert.ok(widget.render(width).every(line => visibleWidth(line) <= width));
  snapshots = [];
  view.refresh();
  assert.equal(e.widgets.size, 0);
  assert.deepEqual(e.statuses, []);
});

test("只读列表展示命令、状态和耗时，窄屏、导航及 Enter 不产生任务操作", async t => {
  const e = uiHarness();
  const snapshots = jobs(30);
  snapshots[0]!.command = "printf '你好🙂'; \x1b]52;c;clipboard-data\x07";
  const view = createTuiJobsUi(e.ctx, () => snapshots);
  t.after(() => { view.dispose(); e.tui.stop(); });
  const opening = view.show();
  assert.equal(view.show(), opening, "重复打开复用同一弹层");
  await until(() => e.panels.length === 1);
  const panel = e.panels[0]!;
  let lines = panel.render(80);
  assert.match(lines.join("\n"), /job-00000000.*BG.*running.*\ds/);
  assert.ok(lines.join("\n").includes("你好🙂"));
  assert.ok(!lines.some(line => /[\u0000-\u001f\u007f-\u009f]/.test(line)), "命令不能注入终端控制序列");
  for (const width of [1, 12, 28, 40]) assert.ok(panel.render(width).every(line => visibleWidth(line) <= width));
  assert.ok(panel.render(40).join("\n").includes("Command: printf"), "窄屏仍能查看选中任务的命令");
  panel.handleInput!("\x1b[F");
  assert.match(panel.render(80).join("\n"), /→ job-0000001d/);
  snapshots[29]!.status = "completed";
  snapshots[29]!.ended_at = snapshots[29]!.started_at + 1100;
  assert.match(panel.render(80).join("\n"), /→ job-0000001d.*completed.*1\.1s/);
  panel.handleInput!("\x1b[5~");
  assert.ok(!panel.render(80).join("\n").includes("→ job-0000001d"));
  panel.handleInput!("\r");
  assert.equal(e.panels.length, 1);
  assert.equal(e.customCalls, 1);
  assert.deepEqual(e.notifications, []);
  e.terminal.rows = 10;
  lines = panel.render(40);
  assert.ok(lines.length <= 8);
  panel.handleInput!("\x1b");
  await opening;
  assert.deepEqual(panel.render(80), []);
});

test("列表打开才创建刷新定时器，关闭后清理，旧入口不能重开", async t => {
  const e = uiHarness();
  const ticks: Array<() => void> = [];
  const cleared: unknown[] = [];
  t.mock.method(globalThis, "setInterval", (callback: () => void) => { ticks.push(callback); return { unref() {} }; });
  t.mock.method(globalThis, "clearInterval", (timer: unknown) => cleared.push(timer));
  let renders = 0;
  t.mock.method(e.tui, "requestRender", () => { renders++; });
  const view = createTuiJobsUi(e.ctx, () => jobs());
  view.refresh();
  assert.equal(ticks.length, 0);
  const widget = e.widgets.values().next().value!;
  widget.render(80);
  const opening = view.show();
  await until(() => e.panels.length === 1);
  assert.equal(ticks.length, 1);
  view.dispose();
  await opening;
  assert.ok(cleared.length >= 1);
  const before = renders;
  ticks[0]!();
  assert.equal(renders, before);
  await view.show();
  assert.equal(e.customCalls, 1);
  assert.equal(e.widgets.size, 0);
  e.tui.stop();
});

for (const fullscreen of [false, true]) {
  test(`真实 ${fullscreen ? "全屏" : "普通"} TUI 路由：点击能力、Esc 归属和编辑器焦点恢复`, async t => {
    const e = uiHarness(fullscreen);
    let interrupts = 0;
    const editor = { render: () => ["Editor"], invalidate() {}, handleInput: (data: string) => { if (matchesKey(data, Key.escape)) interrupts++; } };
    e.tui.addChild(editor);
    e.tui.setFocus(editor);
    const view = createTuiJobsUi(e.ctx, () => jobs());
    t.after(() => { view.dispose(); e.tui.stop(); });
    view.refresh();
    e.tui.start();
    await until(() => e.terminal.writes.some(write => write.includes("Bash jobs:")));
    const frame = e.tui instanceof TuiAltScreen ? e.tui.getScreenLines() : e.tui.captureRenderState().previousLines;
    const row = frame.findIndex(line => line.includes("Bash jobs:"));
    assert.ok(row >= 0);
    e.terminal.input!(`\x1b[<0;2;${row + 1}M`);
    e.terminal.input!(`\x1b[<0;2;${row + 1}m`);
    if (fullscreen) await until(() => e.panels.length === 1);
    else assert.equal(e.customCalls, 0, "普通模式鼠标由终端接管");
    const opening = view.show();
    await until(() => e.panels.length === 1);
    await until(() => e.tui.getFocusedComponent() === e.panels[0]);
    e.terminal.input!("\x1b");
    await opening;
    assert.equal(interrupts, 0, "弹层中的 Esc 不传给主 agent");
    assert.equal(e.tui.getFocusedComponent(), editor);
    e.terminal.input!("\x1b");
    assert.equal(interrupts, 1, "关闭后恢复编辑器原来的 Esc 行为");
  });
}

test("CLI 的命令和快捷键打开同一只读列表，树导航清理旧弹层和入口", async t => {
  const e = uiHarness();
  const h = harness({ mode: "tui" });
  Object.assign(h.ctx.ui, e.ui);
  t.after(async () => { await h.close(); e.tui.stop(); });
  await h.emit("session_start");
  h.ctx.isIdle = () => false;
  const result = await h.call("bash", { command: "sleep 5; printf done", background: true });
  const id = object(result.structuredContent).job_id;
  assert.ok(e.widgets.size > 0);
  const before = h.messages.length;
  const command = h.commands.get("bash-jobs").handler("", h.ctx);
  const shortcut = h.shortcuts.get(TUI_JOBS_SHORTCUT).handler(h.ctx);
  await until(() => e.panels.length === 1);
  assert.equal(e.customCalls, 1);
  assert.ok(e.panels[0]!.render(80).join("\n").includes(id));
  assert.equal(h.messages.length, before, "查看不追加模型消息");
  assert.equal(object((await h.call("bash_jobs", { action: "status", id })).structuredContent).job.status, "running");
  await h.emit("session_tree");
  await Promise.all([command, shortcut]);
  assert.equal(e.widgets.size, 0);
  assert.deepEqual(e.panels[0]!.render(80), []);
  assert.equal(h.messages.length, before, "会话清理不发送旧任务通知");
  assert.ok(e.statuses.every(status => status === undefined), "CLI 不再重复显示原 status 数量");
});

test("宿主延后创建界面时，已关闭会话不会留下弹层或定时器", async t => {
  const e = uiHarness();
  let factory: Parameters<ExtensionUIContext["custom"]>[0] | undefined;
  let done: (() => void) | undefined;
  let intervals = 0;
  t.mock.method(globalThis, "setInterval", () => { intervals++; return { unref() {} }; });
  e.ui.custom = ((callback: typeof factory) => {
    factory = callback;
    return new Promise<void>(resolve => { done = resolve; });
  }) as ExtensionUIContext["custom"];
  const view = createTuiJobsUi(e.ctx, () => jobs());
  const opening = view.show();
  view.dispose();
  const component = await factory!(e.tui, { fg: (_color: string, text: string) => text } as Theme,
    new KeybindingsManager(TUI_KEYBINDINGS) as unknown as AgentKeys, done!);
  await opening;
  assert.equal(intervals, 0);
  assert.ok(!component.render(80).join("\n").includes("Bash jobs"));
  e.tui.stop();
});

test("关闭 CLI 界面失败也不能跳过旧任务的进程清理", async t => {
  const e = uiHarness();
  const h = harness({ mode: "tui" });
  Object.assign(h.ctx.ui, e.ui);
  t.mock.method(console, "error", () => {});
  t.after(async () => { await h.close(); e.tui.stop(); });
  await h.emit("session_start");
  h.ctx.isIdle = () => false;
  await h.call("bash", { command: "sleep 5", background: true });
  assert.equal(e.widgets.size, 1);
  const old = e.widgets.values().next().value!;
  h.ctx.ui.setWidget = (() => { throw new Error("Host UI already reset"); }) as ExtensionUIContext["setWidget"];
  await h.emit("session_shutdown");
  assert.deepEqual(old.render(80), []);
  const result = object((await h.call("bash_jobs", { action: "list" })).structuredContent);
  assert.deepEqual(result.jobs, [], "新实例不能残留旧任务");
  assert.equal(h.messages.length, 0);
});

test("TUI 由宿主提供，包及两个锁文件声明一致的 peer，不增加运行时依赖", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const local = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const root = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], ">=1.5.2 <2");
  assert.equal(local.packages[""].peerDependencies["@earendil-works/pi-tui"], manifest.peerDependencies["@earendil-works/pi-tui"]);
  assert.equal(root.packages["pi-background-bash"].peerDependencies["@earendil-works/pi-tui"], manifest.peerDependencies["@earendil-works/pi-tui"]);
});
