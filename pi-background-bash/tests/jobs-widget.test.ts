import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings, KeybindingsManager, matchesKey, Key, setKeybindings, TUI_KEYBINDINGS, TuiAltScreen, TuiMainScreen,
  visibleWidth, type Component, type Terminal, type TUI,
} from "@earendil-works/pi-tui";
import { createJobsWidget, JOBS_WIDGET_SHORTCUT } from "../src/jobs-widget.ts";
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
  start(input: (data: string) => void) { this.input = input; }
  stop() { this.input = undefined; }
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
  if (tui instanceof TuiAltScreen) tui.setCopyOnSelect(false);
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  const widgets = new Map<string, Component & { dispose?(): void }>();
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  let customCalls = 0;
  const ui = {
    setStatus: (_key: string, text?: string) => statuses.push(text),
    setFooter: () => { throw new Error("The widget must not replace the footer"); },
    custom: () => { customCalls++; throw new Error("No separate modal or click entry is allowed"); },
    notify: (text: string) => notifications.push(text),
    onTerminalInput: (handler: Parameters<ExtensionUIContext["onTerminalInput"]>[0]) => tui.addInputListener(handler),
    setWidget: (key: string, factory: ((view: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined, options?: { placement?: string }) => {
      assert.equal(options?.placement ?? "belowEditor", "belowEditor");
      const old = widgets.get(key);
      if (old) { old.dispose?.(); tui.removeChild(old); }
      widgets.delete(key);
      if (factory) { const widget = factory(tui, theme); widgets.set(key, widget); tui.addChild(widget); }
      tui.requestRender();
    },
  } as unknown as ExtensionUIContext;
  const ctx = { mode: "tui", hasUI: true, ui } as ExtensionContext;
  return { terminal, tui, ui, ctx, widgets, notifications, statuses, get customCalls() { return customCalls; } };
}

function jobs(count = 1): JobSnapshot[] {
  const started_at = Date.now() - 5000;
  return Array.from({ length: count }, (_, index) => ({
    id: `job-${index.toString(16).padStart(8, "0")}`, command: `printf task-${index}`, cwd: "/tmp",
    status: "running", background: true, started_at, output_path: `/tmp/job-${index}.log`, output_bytes: 0,
  }));
}

test("CLI 摘要只计后台运行任务，命令展开的是同一个 widget 而非弹层", t => {
  const e = uiHarness();
  let snapshots = jobs(3);
  snapshots[1]!.background = false;
  snapshots[2]!.status = "completed";
  const view = createJobsWidget(e.ctx, () => snapshots);
  t.after(() => { view.dispose(); e.tui.stop(); });
  view.refresh();
  const widget = e.widgets.get("pi-background-bash")!;
  assert.equal(widget.render(80).length, 1);
  assert.match(widget.render(80)[0]!, /1 background running/);
  assert.equal(widget.handleMouse, undefined, "移除原来的独立鼠标点击入口");
  view.show();
  assert.equal(e.widgets.get("pi-background-bash"), widget);
  const text = widget.render(80).join("\n");
  assert.match(text, /job-00000000.*BG.*running/);
  assert.ok(text.includes("printf task-0"));
  assert.ok(!text.includes("job-00000001"), "前台任务不进入 widget");
  assert.ok(!text.includes("job-00000002"), "已结束的后台任务不进入 widget");
  view.toggle();
  assert.equal(widget.render(80).length, 1);
  snapshots[0]!.status = "completed";
  view.refresh();
  assert.equal(e.widgets.size, 0, "最后一个后台任务结束即隐藏，即使前台任务仍在运行");
  assert.deepEqual(widget.render(80), []);
  view.show(); view.toggle(); view.refresh();
  assert.equal(e.widgets.size, 0, "命令和快捷键不能强制显示历史记录");
  snapshots[0]!.status = "running";
  view.refresh();
  assert.equal(e.widgets.get("pi-background-bash")!.render(80).length, 1, "下一批任务默认收起");
  snapshots = [];
  view.refresh();
  assert.equal(e.widgets.size, 0);
  assert.equal(e.customCalls, 0);
});

test("widget 的窄屏、分页和控制字符安全，导航不修改任务数据", t => {
  const previousKeys = getKeybindings();
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
  t.after(() => setKeybindings(previousKeys));
  const e = uiHarness();
  const editor = { render: () => ["Editor"], invalidate() {} };
  e.tui.setFocus(editor);
  const snapshots = jobs(30);
  snapshots[0]!.command = "printf '你好🙂'; \x1b]52;c;clipboard-data\x07";
  const original = JSON.stringify(snapshots);
  const view = createJobsWidget(e.ctx, () => snapshots);
  t.after(() => { view.dispose(); e.tui.stop(); });
  view.show();
  const widget = e.widgets.get("pi-background-bash")!;
  const text = widget.render(80).join("\n");
  assert.match(text, /job-00000000.*BG.*running.*\ds/);
  assert.ok(text.includes("你好🙂"));
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(text.replace(/\n/g, "")));
  for (const width of [1, 12, 28, 40]) assert.ok(widget.render(width).every(line => visibleWidth(line) <= width));
  assert.equal(widget.handleInput!("\x1b[F"), true);
  assert.ok(widget.render(80).join("\n").includes("job-0000001d"));
  assert.equal(widget.handleInput!("\x1b[5~"), true);
  assert.ok(!widget.render(80).join("\n").includes("job-0000001d"));
  assert.equal(widget.handleInput!("\r"), false);
  assert.equal(JSON.stringify(snapshots), original);
  assert.equal(e.tui.getFocusedComponent(), editor, "查看从未移动编辑器焦点");
});

test("RPC widget 总是提供完整列表，不依赖 TUI 鼠标、焦点、快捷键或弹层", t => {
  const snapshots = jobs(36);
  snapshots[30]!.background = false;
  const terminalStates = ["completed", "failed", "stopped", "timed_out", "output_limit"] as const;
  terminalStates.forEach((status, index) => { snapshots[31 + index]!.status = status; });
  let removed = 0;
  let widget: Component & { dispose?(): void };
  const ctx = {
    mode: "rpc", hasUI: true,
    ui: {
      setWidget: (_key: string, factory?: (tui: TUI, theme: Theme) => Component) => {
        if (factory) widget = factory({ terminal: { rows: 4, columns: 80 }, requestRender() {} } as unknown as TUI,
          { fg: (_color: string, text: string) => text } as Theme);
        else removed++;
      },
      onTerminalInput: () => { throw new Error("RPC cannot register terminal input"); },
      custom: () => { throw new Error("RPC cannot open the CLI modal"); },
    },
  } as unknown as ExtensionContext;
  const view = createJobsWidget(ctx, () => snapshots);
  t.after(() => view.dispose());
  view.refresh();
  const lines = widget!.render(80);
  assert.equal(lines.length, 62, "完整的 30 个任务不会按虚拟终端行数裁剪");
  for (const job of snapshots.slice(0, 30)) assert.ok(lines.join("\n").includes(job.id));
  for (const job of snapshots.slice(30)) assert.ok(!lines.join("\n").includes(job.id));
  assert.ok(!lines.join("\n").includes("Ctrl+Shift+J"));
  assert.ok(!lines.join("\n").includes("Esc:"));
  assert.equal(widget!.handleMouse, undefined);
  snapshots.slice(0, 30).forEach(job => { job.status = "completed"; });
  view.refresh();
  assert.equal(removed, 1);
  assert.deepEqual(widget!.render(80), []);
  view.show(); view.toggle(); view.refresh();
  assert.equal(removed, 1, "仅有前台和历史任务时，命令不会重新注册 RPC widget");
});

test("widget 工厂重建释放旧实例，并保留原按键归属", t => {
  const active = new Set<unknown>();
  t.mock.method(globalThis, "setInterval", () => { const timer = { unref() {} }; active.add(timer); return timer; });
  t.mock.method(globalThis, "clearInterval", (timer: unknown) => active.delete(timer));
  let factory: (tui: TUI, theme: Theme) => Component;
  const ctx = { mode: "tui", hasUI: true, ui: {
    setWidget: (_key: string, value?: typeof factory) => { if (value) factory = value; },
    onTerminalInput: () => () => {},
  } } as unknown as ExtensionContext;
  const view = createJobsWidget(ctx, () => jobs());
  t.after(() => view.dispose());
  view.refresh();
  const editor = { render: () => ["Editor"], invalidate() {} };
  const dialog = { render: () => ["Dialog"], invalidate() {} };
  let focus: Component = editor;
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {}, getFocusedComponent: () => focus } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  const first = factory!(tui, theme);
  view.show();
  assert.equal(active.size, 1);
  focus = dialog;
  const second = factory!(tui, theme);
  assert.equal(active.size, 1, "重新创建只能留下当前实例的计时器");
  assert.deepEqual(first.render(80), [], "旧实例不再显示或持有输入");
  assert.equal(second.handleInput!("\x1b"), false, "重建不能拦截此时打开的弹层");
  focus = editor;
  assert.equal(second.handleInput!("\x1b"), true, "编辑器重新拥有焦点后仍可收起");
  view.dispose();
  assert.equal(active.size, 0);
});

test("运行期间刷新耗时，全部结束或会话清理后不保留定时器", t => {
  const e = uiHarness();
  const snapshots = jobs();
  const ticks: Array<() => void> = [];
  const cleared: unknown[] = [];
  t.mock.method(globalThis, "setInterval", (callback: () => void) => { ticks.push(callback); return { unref() {} }; });
  t.mock.method(globalThis, "clearInterval", (timer: unknown) => cleared.push(timer));
  let renders = 0;
  t.mock.method(e.tui, "requestRender", () => { renders++; });
  const view = createJobsWidget(e.ctx, () => snapshots);
  view.refresh();
  assert.equal(ticks.length, 1);
  snapshots[0]!.status = "completed";
  ticks[0]!();
  assert.equal(e.widgets.size, 0, "周期刷新也会移除没有运行后台任务的 widget");
  assert.ok(cleared.length >= 1);
  snapshots[0]!.status = "running";
  view.refresh();
  assert.equal(ticks.length, 2);
  view.dispose();
  const before = renders;
  ticks[1]!();
  assert.equal(renders, before);
  view.show(); view.toggle();
  assert.equal(e.widgets.size, 0);
  e.tui.stop();
});

for (const fullscreen of [false, true]) {
  test(`真实 ${fullscreen ? "全屏" : "普通"} CLI：原位展开，Esc 只收起，不拦截其他弹层`, async t => {
    const e = uiHarness(fullscreen);
    let interrupts = 0;
    const editor = { render: () => ["Editor"], invalidate() {}, handleInput: (data: string) => { if (matchesKey(data, Key.escape)) interrupts++; } };
    e.tui.addChild(editor); e.tui.setFocus(editor);
    const view = createJobsWidget(e.ctx, () => jobs(5));
    t.after(() => { view.dispose(); e.tui.stop(); });
    view.refresh(); e.tui.start();
    await until(() => e.terminal.writes.some(write => write.includes("Bash jobs:")));
    view.show();
    const widget = e.widgets.get("pi-background-bash")!;
    assert.ok(widget.render(80).join("\n").includes("job-00000000"));
    assert.equal(e.tui.getFocusedComponent(), editor);
    let foreignEsc = 0;
    const foreign = { render: () => ["Other dialog"], invalidate() {}, handleInput: (data: string) => { if (matchesKey(data, Key.escape)) foreignEsc++; } };
    const overlay = e.tui.showOverlay(foreign);
    e.terminal.input!("\x1b");
    assert.equal(foreignEsc, 1, "其他弹层拥有自己的 Esc");
    assert.ok(widget.render(80).length > 1);
    overlay.hide();
    e.terminal.input!("\x1b");
    assert.equal(widget.render(80).length, 1);
    assert.equal(interrupts, 0);
    e.terminal.input!("\x1b");
    assert.equal(interrupts, 1, "收起后恢复编辑器的原生 Esc 行为");
    assert.equal(e.customCalls, 0);
  });
}

test("CLI 命令与快捷键共用 widget，查看不插入模型消息或停止后台任务", async t => {
  const e = uiHarness();
  const h = harness({ mode: "tui" });
  Object.assign(h.ctx.ui, e.ui);
  const editor = { render: () => ["Editor"], invalidate() {} };
  e.tui.setFocus(editor);
  t.after(async () => { await h.close(); e.tui.stop(); });
  await h.emit("session_start"); h.ctx.isIdle = () => false;
  const result = await h.call("bash", { command: "sleep 5; printf done", background: true });
  const id = object(result.structuredContent).job_id;
  const widget = e.widgets.get("pi-background-bash")!;
  await h.commands.get("bash-jobs").handler("", h.ctx);
  assert.ok(widget.render(80).join("\n").includes(id));
  await h.shortcuts.get(JOBS_WIDGET_SHORTCUT).handler(h.ctx);
  assert.equal(widget.render(80).length, 1);
  assert.equal(object((await h.call("bash_jobs", { action: "status", id })).structuredContent).job.status, "running");
  assert.equal(h.messages.length, 0);
  assert.deepEqual(e.notifications, []);
  assert.equal(e.customCalls, 0);
  await h.emit("session_tree");
  assert.equal(e.widgets.size, 0);
  assert.deepEqual(widget.render(80), []);
});

test("RPC 命令提供 widget，不再只是数量状态或文本通知", async t => {
  const h = harness();
  t.after(() => h.close());
  await h.emit("session_start"); h.ctx.isIdle = () => false;
  const result = await h.call("bash", { command: "sleep 5; printf done", background: true });
  const id = object(result.structuredContent).job_id;
  await h.commands.get("bash-jobs").handler("", h.ctx);
  const factory = h.widgets.get("pi-background-bash")!.content as (tui: TUI, theme: Theme) => Component & { dispose?(): void };
  const widget = factory({ terminal: { rows: 4, columns: 80 }, requestRender() {} } as unknown as TUI,
    { fg: (_color: string, text: string) => text } as Theme);
  assert.ok(widget.render(80).join("\n").includes(id));
  assert.equal(h.statuses.get("pi-background-bash"), undefined);
  assert.deepEqual(h.notifications, []);
  assert.equal(h.messages.length, 0);
});

test("前台任务和历史完成记录不能撑开 widget，bash_jobs 仍可查询完整记录", async t => {
  const e = uiHarness();
  const h = harness({ mode: "tui" });
  Object.assign(h.ctx.ui, e.ui);
  t.after(async () => { await h.close(); e.tui.stop(); });
  await h.emit("session_start"); h.ctx.isIdle = () => false;
  const result = await h.call("bash", { command: "printf background", background: true });
  const id = object(result.structuredContent).job_id;
  await until(() => h.messages.length === 1);
  assert.equal(e.widgets.size, 0);
  const foreground = h.call("bash", { command: "sleep 0.15; printf foreground", timeout: 1 });
  const running = object((await h.call("bash_jobs", { action: "list" })).structuredContent).jobs as JobSnapshot[];
  assert.ok(running.some(job => !job.background && job.status === "running"));
  await h.commands.get("bash-jobs").handler("", h.ctx);
  assert.equal(e.widgets.size, 0, "前台命令运行时也不能显示 widget");
  const finished = await foreground;
  assert.equal(object(finished.structuredContent).output, "foreground");
  const history = object((await h.call("bash_jobs", { action: "list" })).structuredContent).jobs as JobSnapshot[];
  assert.equal(history.length, 2);
  assert.ok(history.some(job => job.id === id && job.background && job.status === "completed"));
  assert.ok(history.some(job => !job.background && job.status === "completed"));
  assert.equal(e.widgets.size, 0);
  assert.equal(h.messages.length, 1, "显示过滤不能改变完成通知");
});

test("旧任务结束后迟到的工厂不能恢复 widget 或覆盖下一批任务", t => {
  const snapshots = jobs();
  const factories: Array<(tui: TUI, theme: Theme) => Component> = [];
  const ctx = { mode: "rpc", hasUI: true, ui: {
    setWidget: (_key: string, value?: (tui: TUI, theme: Theme) => Component) => { if (value) factories.push(value); },
  } } as unknown as ExtensionContext;
  let intervals = 0;
  t.mock.method(globalThis, "setInterval", () => { intervals++; return { unref() {} }; });
  t.mock.method(globalThis, "clearInterval", () => {});
  const view = createJobsWidget(ctx, () => snapshots);
  t.after(() => view.dispose());
  view.refresh();
  snapshots[0]!.status = "completed";
  view.refresh();
  const tui = { terminal: { rows: 4, columns: 80 }, requestRender() {} } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  assert.deepEqual(factories[0]!(tui, theme).render(80), []);
  assert.equal(intervals, 0);
  snapshots[0]!.status = "running";
  view.refresh();
  const current = factories[1]!(tui, theme);
  assert.equal(intervals, 1);
  assert.deepEqual(factories[0]!(tui, theme).render(80), []);
  assert.equal(intervals, 1, "旧工厂不能为新一批任务重启旧计时器");
  assert.ok(current.render(80).join("\n").includes(snapshots[0]!.id));
});

test("周期隐藏 widget 的 UI 异常不抛出，计时器仍先清理", t => {
  const e = uiHarness();
  const snapshots = jobs();
  let tick: () => void;
  let cleared = 0;
  t.mock.method(globalThis, "setInterval", (callback: () => void) => { tick = callback; return { unref() {} }; });
  t.mock.method(globalThis, "clearInterval", () => { cleared++; });
  const errors = t.mock.method(console, "error", () => {});
  const view = createJobsWidget(e.ctx, () => snapshots);
  view.refresh();
  const original = e.ui.setWidget;
  e.ui.setWidget = () => { throw new Error("UI already reset"); };
  snapshots[0]!.status = "completed";
  assert.doesNotThrow(() => tick!());
  assert.equal(cleared, 1);
  assert.equal(errors.mock.callCount(), 1);
  e.ui.setWidget = original;
  view.dispose(); e.tui.stop();
});

test("原生 widget 使用宿主 TUI，包和两个锁文件保留一致 peer 声明", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const local = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const root = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], ">=1.5.2 <2");
  assert.equal(local.packages[""].peerDependencies["@earendil-works/pi-tui"], manifest.peerDependencies["@earendil-works/pi-tui"]);
  assert.equal(root.packages["pi-background-bash"].peerDependencies["@earendil-works/pi-tui"], manifest.peerDependencies["@earendil-works/pi-tui"]);
});

test("清理 widget 失败也继续终止旧进程，迟到工厂不创建新资源", async t => {
  const h = harness({ mode: "tui" });
  t.mock.method(console, "error", () => {});
  t.after(() => h.close());
  await h.emit("session_start"); h.ctx.isIdle = () => false;
  await h.call("bash", { command: "sleep 5", background: true });
  const factory = h.widgets.get("pi-background-bash")!.content as (tui: TUI, theme: Theme) => Component;
  h.ctx.ui.setWidget = (() => { throw new Error("UI already reset"); }) as ExtensionUIContext["setWidget"];
  await h.emit("session_shutdown");
  let intervals = 0;
  t.mock.method(globalThis, "setInterval", () => { intervals++; return { unref() {} }; });
  const late = factory({ requestRender() {} } as TUI, { fg: (_color: string, text: string) => text } as Theme);
  assert.ok(!late.render(80).join("\n").includes("Bash jobs"));
  assert.equal(intervals, 0);
  assert.deepEqual(object((await h.call("bash_jobs", { action: "list" })).structuredContent).jobs, []);
  assert.equal(h.messages.length, 0);
});
