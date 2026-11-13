export const JOB_FORMAT = "pi-background-bash.job.v1";
export const RPC_REQUEST = "pi-background-bash:rpc:v1:request";
const statuses = new Set(["running", "completed", "failed", "stopped", "timed_out", "output_limit"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is import('./api.d.ts').Job} */
export function isJob(value) {
  return isObject(value) && typeof value.id === "string" && /^job-[a-f0-9]{8}$/.test(value.id)
    && typeof value.command === "string" && typeof value.cwd === "string"
    && typeof value.status === "string" && statuses.has(value.status) && typeof value.background === "boolean"
    && typeof value.started_at === "number" && Number.isFinite(value.started_at)
    && typeof value.output_path === "string" && typeof value.output_bytes === "number" && Number.isFinite(value.output_bytes)
    && (value.ended_at === undefined || (typeof value.ended_at === "number" && Number.isFinite(value.ended_at)))
    && (value.exit_code === undefined || (typeof value.exit_code === "number" && Number.isInteger(value.exit_code)))
    && (value.error === undefined || typeof value.error === "string");
}
/** @param {unknown} details @returns {import('./api.d.ts').Job[]} */
export function jobsFromDetails(details) {
  if (!isObject(details) || details.format !== JOB_FORMAT) return [];
  if (isJob(details)) return [details];
  if (isJob(details.job)) return [details.job];
  return Array.isArray(details.jobs) ? details.jobs.filter(isJob) : [];
}
/** @param {import('./api.d.ts').HistoryEntry[]} entries @returns {import('./api.d.ts').JobRecord[]} */
export function historyRecords(entries) {
  /** @type {Map<string, import('./api.d.ts').JobRecord>} */
  const records = new Map();
  for (const entry of entries) {
    const message = entry.message;
    if (!message || entry.omitted) continue;
    const completion = message.role === "custom" && message.customType === "pi-background-bash:completion" && message.display !== false;
    const tool = message.role === "toolResult" && ["bash", "bash_jobs"].includes(String(message.toolName));
    if (!completion && !tool) continue;
    for (const job of jobsFromDetails(message.details)) {
      const details = /** @type {Record<string, unknown>} */ (message.details);
      const old = records.get(job.id);
      records.set(job.id, {
        job, origin: "history",
        ...(old?.output !== undefined ? { output: old.output, truncated: old.truncated } : {}),
        ...(typeof details.output === "string" ? { output: details.output, truncated: details.truncated === true } : {}),
      });
    }
  }
  return [...records.values()].sort((a, b) => b.job.started_at - a.job.started_at).slice(0, 200);
}
/** @param {import('./api.d.ts').JobRecord[]} history @param {import('./api.d.ts').Job[]} live @param {boolean} connected */
export function mergeRecords(history, live, connected) {
  const records = new Map(history.map(record => [record.job.id, record]));
  if (connected) for (const job of live) records.set(job.id, { ...records.get(job.id), job, origin: "live" });
  return [...records.values()].sort((a, b) => b.job.started_at - a.job.started_at);
}
/** @param {import('./api.d.ts').JobRecord} record */
export function statusLabel(record) {
  if (record.origin === "history" && record.job.status === "running") return "历史记录 · 当前状态未确认";
  const labels = { running: "运行中", completed: "已完成", failed: "失败", stopped: "已停止", timed_out: "执行超时", output_limit: "输出超限" };
  return `${labels[record.job.status]}${record.origin === "history" ? " · 历史" : ""}`;
}
/** @param {import('./api.d.ts').Job} job */
export function durationLabel(job) {
  const seconds = Math.max(0, ((job.ended_at ?? Date.now()) - job.started_at) / 1000);
  return seconds < 60 ? `${seconds.toFixed(1)} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
}
