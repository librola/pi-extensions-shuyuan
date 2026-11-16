import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings, isKeyRelease, Key, matchesKey, replaceControlCharacters, Text, truncateToWidth,
  type Component, type TUI,
} from "@earendil-works/pi-tui";
import type { JobSnapshot } from "./jobs.ts";

export const JOBS_WIDGET_SHORTCUT = "ctrl+shift+j";
const WIDGET_KEY = "pi-background-bash";

class JobsWidget implements Component {
  // 原生 TUI 实现提供公开焦点查询；通用工厂类型未声明它，RPC 虚拟 TUI 也不一定提供。
  private readonly tui: TUI & { getFocusedComponent?(): Component | null };
  private readonly theme: Theme;
  private readonly getJobs: () => JobSnapshot[];
  private readonly getExpanded: () => boolean;
  private readonly collapse: () => void;
  private readonly interactive: boolean;
  private inputOwner: Component | null = null;
  private offset = 0;
  private windowSize = 1;
  private jobCount = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(tui: TUI, theme: Theme, getJobs: () => JobSnapshot[], getExpanded: () => boolean, collapse: () => void, interactive: boolean, previous?: JobsWidget) {
    this.tui = tui; this.theme = theme; this.getJobs = getJobs; this.getExpanded = getExpanded;
    this.collapse = collapse; this.interactive = interactive;
    // 重建保留原输入拥有者，不能把此时打开的其他弹层当成编辑器。
    if (previous) this.inputOwner = previous.inputOwner;
    else if (interactive && getExpanded()) this.captureInputOwner();
  }

  captureInputOwner(): void {
    if (this.interactive) this.inputOwner = this.tui.getFocusedComponent?.() ?? null;
  }

  ownsInput(): boolean {
    // 不挪动编辑器焦点；其他弹层打开后不拦截它的 Esc 或方向键。
    return !this.disposed && this.interactive && this.getExpanded() && this.inputOwner !== null
      && this.tui.getFocusedComponent?.() === this.inputOwner;
  }

  update(): void {
    if (this.disposed) return;
    const active = this.getJobs().some(job => job.status === "running");
    // 只有可见 widget 中存在运行任务时刷新耗时；历史记录不会留下空转定时器。
    if (active && !this.timer) {
      this.timer = setInterval(() => this.update(), 1000);
      this.timer.unref();
    } else if (!active && this.timer) {
      clearInterval(this.timer); this.timer = undefined;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const jobs = [...this.getJobs()].sort((a, b) => {
      const priorityA = (a.status === "running" ? 0 : 2) + (a.background ? 0 : 1);
      const priorityB = (b.status === "running" ? 0 : 2) + (b.background ? 0 : 1);
      return priorityA - priorityB || b.started_at - a.started_at;
    });
    this.jobCount = jobs.length;
    const count = jobs.filter(job => job.background && job.status === "running").length;
    const heading = this.theme.fg("accent", `Bash jobs: ${count} background running`);
    if (this.interactive && !this.getExpanded()) {
      return [truncateToWidth(`${heading} ${this.theme.fg("dim", "Ctrl+Shift+J: expand")}`, width)];
    }
    // RPC 必须提供完整内容，原版 Pi Web 的底栏折叠由浏览器负责，不依赖终端鼠标事件。
    this.windowSize = this.interactive ? Math.max(1, Math.min(12, Math.floor((this.tui.terminal.rows * 0.5 - 3) / 2))) : jobs.length;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, jobs.length - this.windowSize)));
    const shown = this.interactive ? jobs.slice(this.offset, this.offset + this.windowSize) : jobs;
    const now = Date.now();
    const lines = [heading, this.theme.fg("dim", "BG: background · FG: foreground · read-only")];
    for (const job of shown) {
      const elapsed = Math.max(0, ((job.ended_at ?? now) - job.started_at) / 1000).toFixed(1);
      lines.push(`${job.id} ${job.background ? "BG" : "FG"} ${job.status}${job.exit_code !== undefined ? ` (${job.exit_code})` : ""} ${elapsed}s`);
      // 命令是数据，不能让控制字符变成终端指令；按显示列截断，保留完整字符。
      lines.push(this.theme.fg("muted", `  ${truncateToWidth(replaceControlCharacters(job.command), 200)}`));
    }
    if (!shown.length) lines.push(this.theme.fg("dim", "No bash jobs in this session."));
    if (this.interactive) lines.push(this.theme.fg("dim", `${jobs.length ? `${this.offset + 1}-${this.offset + shown.length}/${jobs.length} · ` : ""}↑↓ / PgUp PgDn: scroll · Esc: collapse`));
    return lines.map(line => truncateToWidth(line, width));
  }

  handleInput(data: string): boolean {
    if (!this.ownsInput() || isKeyRelease(data)) return false;
    const keys = getKeybindings();
    if (matchesKey(data, Key.escape) || keys.matches(data, "tui.select.cancel")) { this.collapse(); return true; }
    let offset = this.offset;
    if (keys.matches(data, "tui.select.up")) offset--;
    else if (keys.matches(data, "tui.select.down")) offset++;
    else if (keys.matches(data, "tui.select.pageUp")) offset -= this.windowSize;
    else if (keys.matches(data, "tui.select.pageDown")) offset += this.windowSize;
    else if (matchesKey(data, Key.home)) offset = 0;
    else if (matchesKey(data, Key.end)) offset = this.jobCount;
    else return false;
    this.offset = Math.max(0, Math.min(offset, Math.max(0, this.jobCount - this.windowSize)));
    this.tui.requestRender();
    return true;
  }

  invalidate(): void {}
  dispose(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.inputOwner = null; }
}

/** 用同一套原生 widget 支持 CLI 和 RPC；不创建额外点击入口或弹层。 */
export function createJobsWidget(ctx: ExtensionContext, getJobs: () => JobSnapshot[]) {
  const interactive = ctx.mode === "tui";
  let disposed = false;
  let registered = false;
  let expanded = false;
  let requested = false;
  let widget: JobsWidget | undefined;
  const collapse = () => { expanded = false; requested = false; refresh(); };
  const unsubscribe = interactive ? ctx.ui.onTerminalInput(data => {
    if (!disposed && widget?.handleInput(data)) return { consume: true };
  }) : undefined;

  const refresh = () => {
    if (disposed) return;
    if (!requested && !getJobs().some(job => job.background)) {
      widget?.dispose(); widget = undefined;
      if (registered) ctx.ui.setWidget(WIDGET_KEY, undefined);
      registered = false;
      return;
    }
    if (!registered) {
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        if (disposed) return new Text("");
        // 重建先继承按键归属，再清理旧实例；不假定宿主会代管它的计时器。
        const previous = widget;
        widget = new JobsWidget(tui, theme, getJobs, () => expanded, collapse, interactive, previous);
        previous?.dispose();
        widget.update();
        return widget;
      }, { placement: "belowEditor" });
      registered = true;
    }
    widget?.update();
  };
  const show = () => {
    if (disposed) return;
    requested = true; expanded = true;
    refresh(); widget?.captureInputOwner();
  };
  const toggle = () => {
    if (disposed) return;
    if (expanded) collapse(); else show();
  };
  const dispose = () => {
    disposed = true; widget?.dispose(); unsubscribe?.();
    if (registered) ctx.ui.setWidget(WIDGET_KEY, undefined);
    registered = false; widget = undefined;
  };
  return { refresh, show, toggle, dispose };
}
