import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  getSelectPageIndex, Key, matchesKey, MouseRegion, replaceControlCharacters, SelectList, Text,
  truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type KeybindingsManager, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { JobSnapshot } from "./jobs.ts";

export const TUI_JOBS_SHORTCUT = "ctrl+shift+j";
const WIDGET_KEY = "pi-background-bash";

class JobsList implements Component {
  readonly capturesViewportInput = true;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly getJobs: () => JobSnapshot[];
  private readonly done: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private list: SelectList | undefined;
  private itemIds: string[] = [];
  private maxVisible = 1;
  private listRows = 0;
  private disposed = false;

  constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, getJobs: () => JobSnapshot[], done: () => void) {
    this.tui = tui; this.theme = theme; this.keys = keys; this.getJobs = getJobs; this.done = done;
    // 只在列表打开时刷新耗时；关闭后不保留定时器，也不发起工具或模型请求。
    this.timer = setInterval(() => { if (!this.disposed) tui.requestRender(); }, 1000);
    this.timer.unref();
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const jobs = this.getJobs();
    const selectedId = this.list?.getSelectedItem()?.value;
    this.itemIds = jobs.map(job => job.id);
    this.maxVisible = Math.max(1, Math.min(12, Math.floor(this.tui.terminal.rows * 0.8) - 6));
    const now = Date.now();
    this.list = new SelectList(jobs.map(job => ({
      value: job.id,
      label: `${job.id} ${job.background ? "BG" : "FG"} ${job.status}${job.exit_code !== undefined ? ` (${job.exit_code})` : ""} ${Math.max(0, ((job.ended_at ?? now) - job.started_at) / 1000).toFixed(1)}s`,
      // 命令是数据，控制字符不能变成终端指令；按终端列宽截断，保留完整字符。
      description: truncateToWidth(replaceControlCharacters(job.command), 200),
    })), this.maxVisible, {
      selectedPrefix: text => this.theme.fg("accent", text),
      selectedText: text => this.theme.fg("accent", text),
      description: text => this.theme.fg("muted", text),
      scrollInfo: text => this.theme.fg("dim", text),
      noMatch: text => this.theme.fg("dim", text),
    }, { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 38 });
    const selectedIndex = selectedId ? this.itemIds.indexOf(selectedId) : -1;
    this.list.setSelectedIndex(Math.max(0, selectedIndex));
    const lines = jobs.length ? this.list.render(width) : [this.theme.fg("dim", "No bash jobs in this session.")];
    this.listRows = lines.length;
    // 窄屏的列表列宽不足时仍展示所选命令，不让它只剩任务 ID 和状态。
    const description = this.list.getSelectedItem()?.description;
    const detail = description ? wrapTextWithAnsi(this.theme.fg("muted", `Command: ${description}`), Math.max(1, width)).slice(0, 2) : [];
    return [
      this.theme.fg("accent", "Bash jobs"),
      this.theme.fg("dim", "BG: background · FG: foreground · read-only"),
      ...lines,
      ...detail,
      this.theme.fg("dim", "↑↓ / PgUp PgDn: scroll · Esc: close"),
    ].map(line => truncateToWidth(line, width)).slice(0, Math.max(1, Math.floor(this.tui.terminal.rows * 0.8)));
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, Key.escape) || this.keys.matches(data, "tui.select.cancel")) { this.done(); return; }
    if (!this.list || !this.itemIds.length) return;
    const current = this.itemIds.indexOf(this.list.getSelectedItem()!.value);
    let next = getSelectPageIndex(this.keys, data, current, this.itemIds.length, this.maxVisible);
    if (this.keys.matches(data, "tui.select.up")) next = (current + this.itemIds.length - 1) % this.itemIds.length;
    else if (this.keys.matches(data, "tui.select.down")) next = (current + 1) % this.itemIds.length;
    else if (matchesKey(data, Key.home)) next = 0;
    else if (matchesKey(data, Key.end)) next = this.itemIds.length - 1;
    if (next !== undefined) { this.list.setSelectedIndex(next); this.tui.requestRender(); }
  }

  handleMouse(event: TuiMouseEvent) {
    if (this.disposed || !this.list || event.y < 2 || event.y >= 2 + this.listRows) return;
    const result = this.list.handleMouse({ ...event, y: event.y - 2, height: this.listRows });
    if (result?.handled) this.tui.requestRender();
    return result;
  }

  invalidate(): void { this.list?.invalidate(); }
  dispose(): void { this.disposed = true; clearInterval(this.timer); }
}

/** 创建当前 CLI 会话的只读任务入口，不接管宿主 footer。 */
export function createTuiJobsUi(ctx: ExtensionContext, getJobs: () => JobSnapshot[]) {
  let disposed = false;
  let registered = false;
  let widgetTui: TUI | undefined;
  let panel: JobsList | undefined;
  let closePanel: (() => void) | undefined;
  let opening: Promise<void> | undefined;

  const show = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (opening) return opening;
    opening = ctx.ui.custom<void>((tui, theme, keys, done) => {
      // 宿主可以异步创建界面；会话已关闭时不能再留下新弹层或定时器。
      if (disposed) { done(); return new Text(""); }
      closePanel = done;
      panel = new JobsList(tui, theme, keys, getJobs, done);
      return panel;
    }, { overlay: true, overlayOptions: { width: "95%", maxHeight: "80%", anchor: "center" } }).finally(() => {
      panel?.dispose(); panel = undefined; closePanel = undefined; opening = undefined;
    });
    return opening;
  };

  const refresh = () => {
    if (disposed) return;
    if (!getJobs().some(job => job.background)) {
      if (registered) ctx.ui.setWidget(WIDGET_KEY, undefined);
      registered = false; widgetTui = undefined;
      return;
    }
    if (!registered) {
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        widgetTui = tui;
        let clickWidth = 0;
        return new MouseRegion({
          render(width) {
            if (disposed) return [];
            const count = getJobs().filter(job => job.background && job.status === "running").length;
            const line = truncateToWidth(`${theme.fg("accent", `Bash jobs: ${count} running ▸`)} ${theme.fg("dim", "Ctrl+Shift+J")}`, width);
            clickWidth = visibleWidth(line);
            return [line];
          },
          invalidate() {},
        }, event => {
          if (disposed || (event.type !== "press" && event.type !== "click") || event.button !== "left" || event.shift || event.alt || event.ctrl || event.y !== 0 || event.x < 0 || event.x >= clickWidth) return;
          if (event.type === "press") return { handled: true, render: false };
          void show().catch(error => { if (!disposed) ctx.ui.notify(String(error), "error"); });
          // 弹层由宿主获得焦点，不能随后把焦点转回这个只读入口。
          return { handled: true, render: false };
        });
      }, { placement: "belowEditor" });
      registered = true;
    }
    widgetTui?.requestRender();
  };

  const dispose = () => {
    disposed = true;
    panel?.dispose(); closePanel?.();
    if (registered) ctx.ui.setWidget(WIDGET_KEY, undefined);
    registered = false; widgetTui = undefined;
  };
  return { refresh, show, dispose };
}
