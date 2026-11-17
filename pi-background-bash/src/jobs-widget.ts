import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings, isKeyRelease, Key, matchesKey, replaceControlCharacters, Text, truncateToWidth,
  type Component, type TUI,
} from "@earendil-works/pi-tui";
import type { JobSnapshot } from "./jobs.ts";

export const JOBS_WIDGET_SHORTCUT = "ctrl+shift+j";
const WIDGET_KEY = "pi-background-bash";

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor(wholeSeconds / 60) % 60;
  // 硬时限允许小数秒，从配置值的十进制表示取小数，避免浮点取余产生尾数噪声。
  const fraction = String(seconds).split(".")[1];
  const remainder = `${wholeSeconds % 60}${fraction ? `.${fraction}` : ""}`;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", Number(remainder) ? `${remainder}s` : ""].filter(Boolean).join(" ");
}

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
    if (!this.getJobs().length) { this.collapse(); return; }
    // 最后一个后台任务结束时移除 widget；展示异常不能干扰任务执行。
    if (!this.timer) {
      this.timer = setInterval(() => {
        try { this.update(); } catch (error) { console.error("[pi-background-bash] Widget update failed:", error); }
      }, 1000);
      this.timer.unref();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const jobs = [...this.getJobs()].sort((a, b) => b.started_at - a.started_at);
    this.jobCount = jobs.length;
    if (!jobs.length) return [];
    const heading = this.theme.fg("accent", `Bash jobs: ${jobs.length} background running`);
    if (this.interactive && !this.getExpanded()) {
      return [truncateToWidth(`${heading} ${this.theme.fg("dim", "Ctrl+Shift+J: expand")}`, width)];
    }
    // RPC 必须提供完整内容，原版 Pi Web 的底栏折叠由浏览器负责，不依赖终端鼠标事件。
    this.windowSize = this.interactive ? Math.max(1, Math.min(12, Math.floor((this.tui.terminal.rows * 0.5 - 3) / 2))) : jobs.length;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, jobs.length - this.windowSize)));
    const shown = this.interactive ? jobs.slice(this.offset, this.offset + this.windowSize) : jobs;
    const now = Date.now();
    const lines = [heading, this.theme.fg("dim", "BG: background · read-only")];
    for (const job of shown) {
      const elapsed = formatDuration(Math.max(0, Math.floor((now - job.started_at) / 1000)));
      const hardLimit = job.hard_timeout !== undefined ? ` · hard limit ${formatDuration(job.hard_timeout)}` : "";
      lines.push(`${job.id} BG running ${elapsed}${hardLimit}`);
      // 命令是数据，不能让控制字符变成终端指令；按显示列截断，保留完整字符。
      lines.push(this.theme.fg("muted", `  ${truncateToWidth(replaceControlCharacters(job.command), 200)}`));
    }
    if (this.interactive) lines.push(this.theme.fg("dim", `${this.offset + 1}-${this.offset + shown.length}/${jobs.length} · ↑↓ / PgUp PgDn: scroll · Esc: collapse`));
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
  let generation = 0;
  let widget: JobsWidget | undefined;
  const getRunningJobs = () => getJobs().filter(job => job.background && job.status === "running");
  const collapse = () => { expanded = false; refresh(); };
  const unsubscribe = interactive ? ctx.ui.onTerminalInput(data => {
    if (!disposed && widget?.handleInput(data)) return { consume: true };
  }) : undefined;

  const refresh = () => {
    if (disposed) return;
    if (!getRunningJobs().length) {
      generation++; expanded = false;
      widget?.dispose(); widget = undefined;
      if (registered) ctx.ui.setWidget(WIDGET_KEY, undefined);
      registered = false;
      return;
    }
    if (!registered) {
      const currentGeneration = ++generation;
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        // 已结束的一批任务不能通过迟到工厂重新显示，或覆盖后来新启动的任务。
        if (disposed || currentGeneration !== generation || !getRunningJobs().length) return new Text("");
        // 重建先继承按键归属，再清理旧实例；不假定宿主会代管它的计时器。
        const previous = widget;
        widget = new JobsWidget(tui, theme, getRunningJobs, () => expanded, collapse, interactive, previous);
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
    expanded = true;
    refresh(); widget?.captureInputOwner();
  };
  const toggle = () => {
    if (disposed) return;
    if (expanded) collapse(); else show();
  };
  const dispose = () => {
    disposed = true; generation++; widget?.dispose(); unsubscribe?.();
    if (registered) ctx.ui.setWidget(WIDGET_KEY, undefined);
    registered = false; widget = undefined;
  };
  return { refresh, show, toggle, dispose };
}
