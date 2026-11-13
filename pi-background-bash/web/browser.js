import { durationLabel, historyRecords, isJob, isObject, jobsFromDetails, mergeRecords, RPC_REQUEST, statusLabel } from "./parse.js";
import { createDropdown } from "./dropdown.js";

/** @param {import('./api.d.ts').WebHost} host */
export function activate(host) {
  if (host.apiVersion !== 1 || typeof host.registerToolbarItem !== "function") throw new Error("This plugin requires the Pi Web toolbar API");
  const React = host.react;
  const h = React.createElement;
  /** @type {Array<() => void>} */
  const disposers = [];
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = host.extension.assetBaseUrl + "web/style.css";
  document.head.appendChild(stylesheet);

  /** @param {{ context: import('./api.d.ts').ViewContext }} props */
  function Tasks({ context }) {
    const latest = React.useRef(context);
    latest.current = context;
    const generation = React.useRef(0);
    const occupied = React.useRef(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [active, setActive] = React.useState(false);
    const [available, setAvailable] = React.useState(false);
    const [connected, setConnected] = React.useState(false);
    const [automatic, setAutomatic] = React.useState(false);
    const [updatedAt, setUpdatedAt] = React.useState(0);
    const [entries, setEntries] = React.useState(/** @type {import('./api.d.ts').HistoryEntry[]} */ ([]));
    const [before, setBefore] = React.useState(/** @type {string | null} */ (null));
    const paged = React.useRef(false);
    const [live, setLive] = React.useState(/** @type {import('./api.d.ts').Job[]} */ ([]));
    const [selected, setSelected] = React.useState("");
    const selection = React.useRef(selected);
    selection.current = selected;
    const [output, setOutput] = React.useState(/** @type {import('./api.d.ts').JobRecord | null} */ (null));
    const [confirmation, setConfirmation] = React.useState(/** @type {{ action: 'stop' | 'background'; job: import('./api.d.ts').Job; owner: string | null; signal: AbortSignal } | null} */ (null));
    const history = historyRecords(entries);
    const records = mergeRecords(history, live, connected);
    const chosen = records.find(record => record.job.id === selected);
    const currentOutput = output?.job.id === selected && connected ? output : chosen;

    /** @param {(ctx: import('./api.d.ts').ViewContext, current: () => boolean) => Promise<void>} work */
    async function operate(work) {
      const ctx = latest.current;
      const ownGeneration = generation.current;
      if (occupied.current || ctx.signal.aborted) return;
      const current = () => generation.current === ownGeneration && !ctx.signal.aborted;
      occupied.current = true;
      setBusy(true);
      setError("");
      try { await work(ctx, current); }
      catch (failure) {
        if (current()) {
          setError(failure instanceof Error ? failure.message : "任务操作失败");
          setAutomatic(false);
        }
      } finally {
        if (current()) { occupied.current = false; setBusy(false); }
      }
    }
    /** @param {import('./api.d.ts').ViewContext} ctx @param {string} jobId @param {() => boolean} current */
    async function readOutput(ctx, jobId, current) {
      const { result } = await ctx.invokeAction("output", { id: jobId, tail: 200 });
      if (!isObject(result) || !isJob(result.job) || result.job.id !== jobId || typeof result.output !== "string" || typeof result.truncated !== "boolean") throw new Error("不支持的任务输出格式");
      if (current()) {
        setOutput({ job: result.job, output: result.output, truncated: result.truncated, origin: "live" });
        const job = result.job;
        setLive(value => value.map(item => item.id === jobId ? job : item));
      }
    }
    async function refresh() {
      await operate(async (ctx, current) => {
        const { result } = await ctx.invokeAction("list", {});
        if (!isObject(result) || !Array.isArray(result.jobs) || result.jobs.length > 64 || !result.jobs.every(isJob)) throw new Error("不支持的任务列表格式");
        const jobs = /** @type {import('./api.d.ts').Job[]} */ (result.jobs);
        if (!current()) return;
        setLive(jobs);
        setConnected(true);
        setUpdatedAt(Date.now());
        const jobId = selection.current;
        if (jobs.some(job => job.id === jobId)) await readOutput(ctx, jobId, current);
      });
    }
    /** @param {import('./api.d.ts').JobRecord} record */
    async function select(record) {
      setSelected(record.job.id);
      setOutput(null);
      if (record.origin === "live") await operate((ctx, current) => readOutput(ctx, record.job.id, current));
    }
    async function older() {
      if (!before) return;
      const cursor = before;
      await operate(async (ctx, current) => {
        const page = await ctx.readEntries({ tail: 100, before: cursor, customTypes: [], messageRoles: ["toolResult", "custom"] });
        if (current()) { paged.current = true; setEntries(value => [...page.entries, ...value]); setBefore(page.nextBefore); }
      });
    }
    async function confirm() {
      const pending = confirmation;
      if (!pending || pending.owner !== latest.current.sessionId || pending.signal !== latest.current.signal || pending.signal.aborted) return;
      setConfirmation(null);
      await operate(async (ctx, current) => {
        const { result } = await ctx.invokeAction(pending.action, { id: pending.job.id });
        if (!isObject(result) || !isJob(result.job) || result.job.id !== pending.job.id) throw new Error("不支持的任务操作结果");
        if (current()) {
          const job = result.job;
          setLive(value => value.map(item => item.id === job.id ? job : item));
          setUpdatedAt(Date.now());
          if (selection.current === job.id) await readOutput(ctx, job.id, current);
        }
      });
    }

    React.useEffect(() => {
      generation.current++;
      occupied.current = false;
      setBusy(false); setError(""); setActive(false); setAvailable(false); setConnected(false); setAutomatic(false);
      setEntries([]); setBefore(null); paged.current = false; setLive([]); setSelected(""); setOutput(null); setConfirmation(null); setUpdatedAt(0);
      let owned = true;
      const ctx = latest.current;
      if (ctx.sessionId) ctx.readCapabilities().then(value => {
        if (owned && !ctx.signal.aborted) {
          setActive(value.active);
          setAvailable(value.events.includes(RPC_REQUEST));
        }
      }).catch(failure => { if (owned && !ctx.signal.aborted) setError(String(failure)); });
      return () => { owned = false; generation.current++; occupied.current = false; };
    }, [context.sessionId, context.cwd, context.signal]);

    // 只读历史轻量同步完成通知；不导入后端桥、不启动会话，也不查询进程状态。
    React.useEffect(() => {
      if (!context.sessionId) return;
      let owned = true;
      let reading = false;
      const read = async () => {
        if (reading || document.hidden || context.signal.aborted) return;
        reading = true;
        try {
          const page = await context.readEntries({ tail: 100, customTypes: [], messageRoles: ["toolResult", "custom"] });
          if (!owned || context.signal.aborted) return;
          setEntries(value => {
            const ids = new Set(page.entries.map(entry => entry.id));
            return [...value.filter(entry => !ids.has(entry.id)), ...page.entries];
          });
          if (!paged.current) setBefore(page.nextBefore);
        } catch (failure) {
          if (owned && !context.signal.aborted) setError(String(failure));
        } finally { reading = false; }
      };
      void read();
      const timer = setInterval(() => { void read(); }, 2000);
      return () => { owned = false; clearInterval(timer); };
    }, [context.sessionId, context.signal, context.leafId]);

    // 只有用户明确开启后才查询实时状态；隐藏或卸载的视图不持有轮询资源。
    React.useEffect(() => {
      if (!automatic) return;
      const timer = setInterval(() => {
        if (!document.hidden && !latest.current.signal.aborted) void refresh();
      }, 2000);
      return () => clearInterval(timer);
    }, [automatic, context.sessionId, context.signal]);

    return h("section", { className: "pbb-panel", "data-pbb": "panel" },
      h("div", { className: "pbb-actions" },
        h("button", { type: "button", disabled: busy || !context.sessionId || !active || !available, onClick: refresh }, busy ? "操作中…" : "刷新任务"),
        h("button", { type: "button", disabled: !context.sessionId || !active || !available || busy, "aria-pressed": automatic,
          onClick: () => { const enable = !automatic; setAutomatic(enable); if (enable) void refresh(); } }, automatic ? "停止实时刷新" : "开启实时刷新")),
      h("p", { className: "pbb-muted" }, !context.sessionId ? "请选择一个会话。" : !active ? "原生会话未运行。这里只展示历史，不会自动启动 agent；开启会话并原生 reload 后重新展开下拉框。" : !available ? "当前会话未加载兼容的 pi-background-bash。原生 /reload 后重新展开下拉框。" : connected ? `状态来自上次查询${updatedAt ? "（" + new Date(updatedAt).toLocaleTimeString() + "）" : ""}。查询不调用模型。` : "当前只读历史；点击刷新任务连接已加载的原生实例。"),
      error ? h("p", { role: "alert", className: "pbb-error" }, error) : null,
      h("div", { className: "pbb-layout" },
        h("div", { className: "pbb-list" },
          records.length ? records.map(record => h("article", { key: record.job.id, className: "pbb-job", "data-job-id": record.job.id },
            h("button", { type: "button", className: "pbb-job-select", "aria-pressed": selected === record.job.id, onClick: () => select(record) },
              h("strong", null, record.job.id), h("span", { className: "pbb-status", "data-status": record.job.status }, statusLabel(record)),
              h("code", null, record.job.command),
              h("small", null, `${durationLabel(record.job)}${record.job.exit_code !== undefined ? ` · 退出码 ${record.job.exit_code}` : ""}`)),
            record.origin === "live" && record.job.status === "running" ? h("div", { className: "pbb-actions" },
              !record.job.background ? h("button", { type: "button", disabled: busy,
                onClick: () => setConfirmation({ action: "background", job: record.job, owner: context.sessionId, signal: context.signal }) }, "转入后台") : null,
              h("button", { type: "button", disabled: busy, className: "pbb-danger",
                onClick: () => setConfirmation({ action: "stop", job: record.job, owner: context.sessionId, signal: context.signal }) }, "停止任务")) : null))
            : h("p", { className: "pbb-muted" }, "没有可展示的任务。"),
          before && history.length < 200 ? h("button", { type: "button", disabled: busy, onClick: older }, "加载更早记录") : null,
          history.length >= 200 ? h("p", { className: "pbb-muted" }, "最多展示最近 200 个历史任务。") : null),
        h("div", { className: "pbb-output" },
          h("h3", null, chosen ? `输出 · ${chosen.job.id}` : "任务输出"),
          chosen ? h(React.Fragment, null,
            h("p", { className: "pbb-muted" }, chosen.origin === "live" ? "当前输出末尾最多 200 行 / 16 KiB。" : "这是会话记录中的历史摘要，不表示任务仍在运行。"),
            h("pre", { "data-pbb": "output" }, currentOutput?.output ?? "选择任务后可读取当前输出；历史任务可能没有保存输出摘要。"),
            currentOutput?.truncated ? h("p", { className: "pbb-muted" }, "摘要已截断，完整日志仍由原生插件管理。") : null,
            h("p", { className: "pbb-log-path" }, "日志：", h("code", null, chosen.job.output_path)))
            : h("p", { className: "pbb-muted" }, "点击任务查看输出。"))),
      confirmation ? h("div", { role: "alertdialog", "aria-label": confirmation.action === "stop" ? "确认停止任务" : "确认转入后台", className: "pbb-confirm" },
        h("p", null, `${confirmation.action === "stop" ? "停止任务及其进程树？" : "将前台命令移交后台？"} ${confirmation.job.id}`),
        h("code", null, confirmation.job.command),
        h("div", { className: "pbb-actions" },
          h("button", { type: "button", onClick: confirm, disabled: busy }, confirmation.action === "stop" ? "确认停止" : "确认移交"),
          h("button", { type: "button", onClick: () => setConfirmation(null) }, "取消"))) : null);
  }

  const dropdown = createDropdown(React, Tasks);

  /** @param {import('./api.d.ts').ToolProps} props */
  function ToolCard({ result, defaultView }) {
    const jobs = jobsFromDetails(result?.details);
    return h("section", { className: "pbb-card", "data-pbb": "tool" },
      jobs.slice(0, 3).map(job => h("div", { key: job.id }, h("strong", null, job.id), " · ", statusLabel({ job, origin: "history" }))),
      defaultView);
  }
  /** @param {import('./api.d.ts').MessageProps} props */
  function CompletionCard({ message, defaultView }) {
    const job = jobsFromDetails(message.details)[0];
    return h("section", { className: "pbb-card", "data-pbb": "completion" },
      h("strong", null, job ? `${job.id} · ${statusLabel({ job, origin: "history" })}` : "后台任务完成"),
      job ? h("p", null, `${durationLabel(job)}${job.exit_code !== undefined ? ` · 退出码 ${job.exit_code}` : ""}`) : null,
      defaultView);
  }

  disposers.push(host.registerToolbarItem({ id: "jobs", title: "后台 Bash 任务", component: dropdown.component }));
  if (typeof host.registerToolRenderer === "function") disposers.push(host.registerToolRenderer({ id: "job", title: "后台 Bash", component: ToolCard,
    match: ({ tool, result }) => ["bash", "bash_jobs"].includes(tool.toolName) && jobsFromDetails(result?.details).length > 0 }));
  if (typeof host.registerMessageRenderer === "function") disposers.push(host.registerMessageRenderer({ id: "completion", title: "后台 Bash 完成", component: CompletionCard,
    match: ({ message }) => message.role === "custom" && message.customType === "pi-background-bash:completion" && jobsFromDetails(message.details).length > 0 }));
  if (typeof host.registerWebCommand === "function") disposers.push(host.registerWebCommand({ name: "bash-jobs", description: "展开顶部后台任务下拉框（不发送模型提示）", run: ({ context }) => {
    if (!dropdown.open(context)) throw new Error("当前工具栏尚未就绪，请从顶部后台任务按钮打开。");
  } }));
  return () => { for (const remove of disposers.reverse()) remove(); stylesheet.remove(); };
}
