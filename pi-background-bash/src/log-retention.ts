import { constants, existsSync, lstatSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { JobSnapshot } from "./jobs.ts";
import { LOG_DIRECTORY_PATTERN, LOG_FILE_PATTERN, LOG_INDEX_NAME, LOG_MAX_AGE_MS, logReferences, sessionFileStamp, SessionLogScanner, transcriptReferences } from "./log-context.ts";
import { legacyLogCandidates, openLegacyLogs, unchangedLegacyLog, type OpenLogScan } from "./legacy-logs.ts";

const sharedScanners = new Map<string, SessionLogScanner>();
const collectingRoots = new Set<string>();
const failedIndexOwners = new Set<LogRetention>();

export { LOG_INDEX_NAME } from "./log-context.ts";
export type RetainedLog = { path: string; id: string; toolCallId?: string; resultTimestamp?: number; contentHash?: string; fingerprints?: Array<{ head: string; length: number; hash: string }>; resultKind?: "completion" | "tool"; startedAt: number; endedAt?: number; running: boolean; background?: boolean; fileStamp?: string; seen: boolean };
type LogIndex = {
  version: 1; sessionId: string; sessionFile?: string; ownerPid: number; closed: boolean;
  activityAt: number; contextAt: number; contextConfirmed: boolean; inFlight: boolean; uncertain?: boolean; uncertainAt?: number;
  references: string[]; seenHints: string[]; records: RetainedLog[]; collected?: Array<{ path: string; at: number; finishedAt?: number }>;
};
type LoadedIndex = { directory: string; directoryIdentity: string; path: string; stamp: string; index: LogIndex };
export type LogCollectionReport = { deleted: number; removedDirectories: number; skippedUnknown: boolean };

function contentHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex"); }
function textFingerprints(content: unknown): Array<{ head: string; length: number; hash: string }> {
  const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.flatMap(item => item?.type === "text" && typeof item.text === "string" ? [item.text] : []) : [];
  return texts.filter(Boolean).map(text => ({ head: text.slice(0, 48), length: text.length, hash: createHash("sha256").update(text).digest("hex") }));
}
function payloadContains(payload: unknown, record: RetainedLog): boolean {
  const strings: string[] = [];
  const objects: object[] = [];
  const visited = new WeakSet<object>();
  const walk = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object" && !visited.has(value)) { visited.add(value); objects.push(value); Object.values(value).forEach(walk); }
  };
  walk(payload);
  const matches = (values: string[]) => Boolean(record.fingerprints?.length) && record.fingerprints!.every(fingerprint => values.some(value => {
    let offset = value.indexOf(fingerprint.head);
    while (offset >= 0) {
      if (createHash("sha256").update(value.slice(offset, offset + fingerprint.length)).digest("hex") === fingerprint.hash) return true;
      offset = value.indexOf(fingerprint.head, offset + 1);
    }
    return false;
  }));
  if (record.resultKind === "completion") return matches(strings);
  if (typeof record.toolCallId !== "string") return false;
  // 空输出等通用正文不能借另一条工具结果证明已读，必须在同一个工具 ID 对象中匹配原文。
  return objects.some(object => Object.values(object).includes(record.toolCallId) && matches(Object.values(object).flatMap(value => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(item => typeof item?.text === "string" ? [item.text] : []) : [])));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function fileStamp(path: string): string { const stat = lstatSync(path); return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
function stamp(path: string): string { const stat = lstatSync(path); return `${stat.ino}:${stat.size}:${stat.mtimeMs}`; }
function writeIndex(path: string, data: LogIndex): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(data), { flag: "wx", mode: 0o600 }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function loadIndex(directory: string): LoadedIndex | undefined {
  const path = join(directory, LOG_INDEX_NAME);
  try {
    const dir = lstatSync(directory); const file = lstatSync(path);
    if (!dir.isDirectory() || dir.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.size > 8 * 1024 * 1024) return;
    if (process.getuid && (dir.uid !== process.getuid() || file.uid !== process.getuid())) return;
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let index: LogIndex;
    try { index = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
    if (index.version !== 1 || typeof index.sessionId !== "string" || !Number.isInteger(index.ownerPid) || index.ownerPid <= 0
      || typeof index.closed !== "boolean" || !Number.isFinite(index.activityAt) || !Number.isFinite(index.contextAt)
      || typeof index.contextConfirmed !== "boolean" || typeof index.inFlight !== "boolean"
      || (index.uncertain !== undefined && typeof index.uncertain !== "boolean") || (index.uncertainAt !== undefined && !Number.isFinite(index.uncertainAt))
      || !Array.isArray(index.references) || !index.references.every(p => typeof p === "string")
      || !Array.isArray(index.seenHints) || !index.seenHints.every(p => typeof p === "string") || !Array.isArray(index.records)) return;
    if (index.sessionFile !== undefined && (typeof index.sessionFile !== "string" || !index.sessionFile.endsWith(".jsonl"))) return;
    if (!index.records.every(record => record && typeof record.path === "string" && dirname(record.path) === directory
      && LOG_FILE_PATTERN.test(basename(record.path)) && typeof record.id === "string" && Number.isFinite(record.startedAt)
      && (record.endedAt === undefined || Number.isFinite(record.endedAt)) && typeof record.running === "boolean" && typeof record.seen === "boolean"
      && (record.toolCallId === undefined || typeof record.toolCallId === "string")
      && (record.resultTimestamp === undefined || Number.isFinite(record.resultTimestamp))
      && (record.contentHash === undefined || typeof record.contentHash === "string")
      && (record.fileStamp === undefined || typeof record.fileStamp === "string")
      && (record.fingerprints === undefined || (Array.isArray(record.fingerprints) && record.fingerprints.every(f => typeof f.head === "string" && Number.isInteger(f.length) && f.length > 0 && typeof f.hash === "string"))))) return;
    if (index.collected !== undefined && (!Array.isArray(index.collected) || !index.collected.every(item => item && typeof item.path === "string" && Number.isFinite(item.at) && (item.finishedAt === undefined || Number.isFinite(item.finishedAt))))) return;
    return { directory, directoryIdentity: `${dir.dev}:${dir.ino}`, path, stamp: stamp(path), index };
  } catch { return; }
}

/** 引用保护优先于未读七天期限；过期会话只回收日志，运行中的文件始终保留。 */
export function keepLog(record: RetainedLog, activityAt: number, references: ReadonlySet<string>, now: number): boolean {
  if (record.running || references.has(record.path) || references.has(dirname(record.path))) return true;
  if (record.endedAt === undefined || !Number.isFinite(record.endedAt) || record.endedAt > now || record.endedAt < record.startedAt) return true;
  if (now - activityAt >= LOG_MAX_AGE_MS) return false;
  return !record.seen && (record.endedAt === undefined || now - record.endedAt <= LOG_MAX_AGE_MS);
}

/** 每个受管目录一个持久索引，独立于最近二十条任务和唤醒指针；不改写 Pi 会话文件。 */
export class LogRetention {
  private readonly root: string;
  private readonly sessionRoot?: string;
  private readonly now: () => number;
  private readonly state: LogIndex;
  private directoryPath?: string;
  private timer?: ReturnType<typeof setInterval>;
  private readonly scanner: SessionLogScanner;
  private candidates = new Map<string, RetainedLog>();
  private payloadSeen = new Set<string>();
  private payloadObserved = false;
  private contextEpoch = 0;
  private requestEpoch = 0;
  private baseEntryIds: string[] = [];
  private readonly projection?: () => { entries: Array<{ sourceEntry: { id: string; type: string }; messages: unknown[] }> };
  private healthy = true;
  private lastLegacyScan = 0;
  private readonly openLogProbe: () => OpenLogScan;
  private pendingReferences = new Set<string>();
  private collection?: Promise<LogCollectionReport>;
  private closed = false;

  constructor(options: { sessionId: string; sessionFile?: string; sessionRoot?: string; root?: string; now?: () => number; openLogProbe?: () => OpenLogScan; projection?: () => { entries: Array<{ sourceEntry: { id: string; type: string }; messages: unknown[] }> } }) {
    this.projection = options.projection;
    this.root = resolve(options.root ?? tmpdir()); this.sessionRoot = options.sessionRoot; this.now = options.now ?? Date.now;
    this.scanner = sharedScanners.get(this.root) ?? new SessionLogScanner(); sharedScanners.set(this.root, this.scanner);
    this.openLogProbe = options.openLogProbe ?? (() => openLegacyLogs(this.root));
    this.state = { version: 1, sessionId: options.sessionId, sessionFile: options.sessionFile, ownerPid: process.pid, closed: false,
      activityAt: 0, contextAt: 0, contextConfirmed: false, inFlight: false, references: [], seenHints: [], records: [] };
    if (this.projection) {
      try {
        this.state.references = [...transcriptReferences(this.projection().entries.flatMap(entry => entry.messages), this.root)];
        if (this.state.references.length) { this.directory(); this.persist(); }
      } catch (error) { this.healthy = false; console.error("[pi-background-bash] Initial log reference observation failed:", error); }
    }
  }

  directory(): string {
    if (this.closed) throw new Error("Closed log retention cannot reopen its directory");
    if (!this.directoryPath) this.directoryPath = mkdtempSync(join(this.root, "pi-background-bash-"));
    if (!this.timer && !this.closed) {
      this.timer = setInterval(() => { void this.collect(); }, 60 * 60 * 1000);
      this.timer.unref();
    }
    return this.directoryPath;
  }

  private persist(): void {
    if (!this.directoryPath) return;
    try { writeIndex(join(this.directoryPath, LOG_INDEX_NAME), this.state); this.healthy = true; failedIndexOwners.delete(this); }
    catch (error) { this.healthy = false; failedIndexOwners.add(this); console.error("[pi-background-bash] Log retention index update failed:", error); }
  }
  touch(): void { if (this.closed) return; this.state.activityAt = this.now(); this.persist(); }
  created(job: JobSnapshot, toolCallId?: string): void {
    if (this.closed) return;
    this.state.records.push({ path: job.output_path, id: job.id, toolCallId, startedAt: job.started_at, running: true, background: job.background, seen: false });
    this.touch();
  }
  finished(job: JobSnapshot): void {
    if (this.closed) return;
    const record = this.state.records.find(record => record.path === job.output_path);
    if (record) { record.running = false; record.background = job.background; record.endedAt = job.ended_at; record.fileStamp = fileStamp(job.output_path); }
    this.touch();
  }
  completionContent(path: string, content: unknown): void {
    if (this.closed) return;
    const record = this.state.records.find(record => record.path === path);
    if (record && !record.running) {
      record.resultKind = "completion"; record.contentHash = contentHash(content); record.fingerprints = textFingerprints(content);
      record.endedAt = Math.max(record.endedAt ?? 0, this.now()); this.persist();
    }
  }
  observedToolResult(message: { role: string; toolCallId?: string; timestamp?: number; content?: unknown }): void {
    if (this.closed || message.role !== "toolResult" || typeof message.toolCallId !== "string" || !Number.isFinite(message.timestamp)) return;
    const record = [...this.state.records].reverse().find(record => record.toolCallId === message.toolCallId && !record.running && !record.background);
    if (record) {
      record.resultTimestamp = message.timestamp; record.resultKind = "tool"; record.contentHash = contentHash(message.content);
      record.fingerprints = textFingerprints(message.content); record.endedAt = Math.max(record.endedAt ?? 0, message.timestamp!); this.persist();
    }
  }
  observationFailed(): void {
    if (this.closed) return;
    this.contextEpoch++; this.payloadObserved = false; this.payloadSeen.clear();
    this.state.uncertain = true; this.state.uncertainAt = this.now(); this.state.contextConfirmed = false; this.persist();
  }
  private indexes(): LoadedIndex[] {
    return readdirSync(this.root).filter(name => LOG_DIRECTORY_PATTERN.test(name)).flatMap(name => {
      const directory = join(this.root, name);
      const item = loadIndex(directory);
      if (item) return [item];
      const stat = lstatSync(directory);
      if (stat.isDirectory() && !stat.isSymbolicLink() && (!process.getuid || stat.uid === process.getuid()) && existsSync(join(directory, LOG_INDEX_NAME))) throw new Error("Log retention index is unreadable; collection deferred");
      return [];
    });
  }
  prepareContext(messages: readonly unknown[], realRun: boolean): void {
    if (this.closed) return;
    this.candidates.clear(); this.payloadSeen.clear(); this.payloadObserved = false;
    this.requestEpoch = this.contextEpoch;
    this.baseEntryIds = this.projection?.().entries.map(entry => entry.sourceEntry.id) ?? [];
    this.pendingReferences = transcriptReferences(messages, this.root);
    const records = [...this.state.records, ...this.indexes().filter(item => item.index.sessionFile === this.state.sessionFile && item.index.sessionId === this.state.sessionId).flatMap(item => item.index.records)];
    for (const value of messages) {
      if (!value || typeof value !== "object") continue;
      const message = value as Record<string, any>;
      for (const record of records) {
        if ((message.role === "custom" && message.customType === "pi-background-bash:completion" && message.details?.format === "pi-background-bash.job.v1"
          && message.details?.id === record.id && message.details?.output_path === record.path)
          || (message.role === "toolResult" && record.resultTimestamp !== undefined && message.toolCallId === record.toolCallId && message.timestamp === record.resultTimestamp)) {
          if (!record.running && record.contentHash && record.contentHash === contentHash(message.content)) this.candidates.set(record.path, record);
        }
      }
    }
    this.state.inFlight = realRun;
    this.state.references = [...new Set([...this.state.references, ...this.pendingReferences])];
    if (this.state.references.length && !this.directoryPath) this.directory();
    this.persist();
  }
  providerPayload(payload: unknown): void {
    if (this.closed) return;
    this.payloadObserved = true;
    for (const [path, record] of this.candidates) if (payloadContains(payload, record)) this.payloadSeen.add(path);
    const refs = logReferences(payload, this.root);
    for (const path of refs) this.pendingReferences.add(path);
    this.state.references = [...new Set([...this.state.references, ...refs])];
    if (this.state.references.length && !this.directoryPath) this.directory();
    this.persist();
  }
  modelFinished(message: { stopReason: string; content?: unknown }): void {
    if (this.closed) return;
    if (this.state.inFlight) this.state.activityAt = this.now();
    this.state.inFlight = false;
    if (["stop", "toolUse", "length"].includes(message.stopReason)) {
      const seen = new Set([...this.state.seenHints, ...this.payloadSeen]);
      for (const record of this.state.records) if (seen.has(record.path)) record.seen = true;
      this.state.seenHints = [...seen];
      if (this.payloadObserved && this.requestEpoch === this.contextEpoch) {
        this.state.references = [...new Set([...this.pendingReferences, ...logReferences(message.content, this.root)])];
        this.state.contextConfirmed = true; this.state.contextAt = this.now(); this.state.uncertain = false;
        if (!this.directoryPath && this.state.sessionFile && this.indexes().some(item => item.index.sessionFile === this.state.sessionFile && item.index.closed)) this.directory();
      } else {
        this.state.references = [...new Set([...this.state.references, ...logReferences(message.content, this.root)])];
      }
    }
    this.candidates.clear(); this.payloadSeen.clear(); this.persist();
  }
  clearRequest(): void { if (this.closed) return; this.state.inFlight = false; this.candidates.clear(); this.payloadSeen.clear(); this.persist(); }
  compacted(): void {
    if (this.closed) return;
    // 压缩事件只标记新输入尚待确认，不按原始 JSONL 或尚未发送的摘要提前删文件。
    this.contextEpoch++; this.state.contextConfirmed = false; this.persist();
  }
  private syncContextTail(): void {
    if (this.closed || !this.state.contextConfirmed || !this.projection) return;
    const entries = this.projection().entries;
    const prefixMatches = this.baseEntryIds.every((id, index) => entries[index]?.sourceEntry.id === id);
    const added = entries.slice(this.baseEntryIds.length);
    if (!prefixMatches || added.some(entry => ["context_edit", "compaction", "branch_summary"].includes(entry.sourceEntry.type))) {
      this.contextEpoch++; this.state.contextConfirmed = false;
    }
    const messages = prefixMatches ? added.flatMap(entry => entry.messages) : entries.flatMap(entry => entry.messages);
    const refs = transcriptReferences([...messages, ...entries.filter(entry => entry.sourceEntry.type === "system").flatMap(entry => entry.messages)], this.root);
    this.state.references = [...new Set([...this.state.references, ...refs])];
    this.persist();
  }
  wasCollected(path: string): boolean { return Boolean(this.state.collected?.some(record => record.path === path)); }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.state.closed = true; this.state.inFlight = false;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.candidates.clear(); this.persist();
  }

  collect(): Promise<LogCollectionReport> {
    if (this.collection) return this.collection;
    // 同一临时根的会话共用增量缓存，且不并发扫描大历史文件；忙时等待下一个边界再检查。
    if (collectingRoots.has(this.root)) return Promise.resolve({ deleted: 0, removedDirectories: 0, skippedUnknown: true });
    collectingRoots.add(this.root);
    this.collection = this.collectNow().catch(error => {
      console.error("[pi-background-bash] Log collection skipped:", error);
      return { deleted: 0, removedDirectories: 0, skippedUnknown: true };
    }).finally(() => { this.collection = undefined; collectingRoots.delete(this.root); });
    return this.collection;
  }
  private async collectNow(): Promise<LogCollectionReport> {
    const report = { deleted: 0, removedDirectories: 0, skippedUnknown: false };
    // 一个实例发布保护失败时，同进程的其他回收者也不能绕过它；重试整份最新索引后再判断。
    for (const owner of failedIndexOwners) if (owner.root === this.root) owner.persist();
    if ([...failedIndexOwners].some(owner => owner.root === this.root) || !this.healthy) { report.skippedUnknown = true; return report; }
    this.syncContextTail();
    const now = this.now();
    const before = this.indexes();
    if (before.some(item => item.index.uncertain && !item.index.closed)) { report.skippedUnknown = true; return report; }
    const hints = new Set(before.flatMap(item => item.index.seenHints));
    const relevantDirectories = new Set(before.filter(item => {
      const index = item.index;
      if (!index.records.length) return (index.closed || !alive(index.ownerPid)) && (now - index.activityAt >= LOG_MAX_AGE_MS
        || (!index.references.length && !index.seenHints.length)
        || before.some(other => !other.index.closed && alive(other.index.ownerPid) && other.index.contextConfirmed
          && (other.index.sessionFile ?? other.index.sessionId) === (index.sessionFile ?? index.sessionId) && other.index.contextAt >= index.contextAt));
      return index.records.some(record => {
        if (record.running && alive(index.ownerPid)) return false;
        return record.seen || hints.has(record.path) || now - index.activityAt >= LOG_MAX_AGE_MS
          || (record.endedAt !== undefined && now - record.endedAt >= LOG_MAX_AGE_MS) || !alive(index.ownerPid);
      });
    }).map(item => basename(item.directory)));
    const legacyDue = now - this.lastLegacyScan >= 60 * 60 * 1000;
    const legacy = legacyDue ? legacyLogCandidates(this.root, now) : [];
    if (legacyDue) this.lastLegacyScan = now;
    for (const log of legacy) relevantDirectories.add(basename(log.directory));
    if (!relevantDirectories.size) return report;
    const scan = await this.scanner.scan(this.sessionRoot, this.root, relevantDirectories);
    if (!scan.complete) { report.skippedUnknown = true; return report; }
    const directoryNames = readdirSync(this.root).filter(name => LOG_DIRECTORY_PATTERN.test(name)).sort().join("\n");
    const indexes = this.indexes();
    if (indexes.some(item => item.index.ownerPid !== process.pid && !item.index.closed && alive(item.index.ownerPid))) {
      // 跨进程无法原子覆盖其下一次引用发布，等待外部写入者关闭，不能把一次扫描当成锁。
      report.skippedUnknown = true; return report;
    }
    const activity = new Map<string, number>();
    const liveContexts = new Map<string, Set<string>>();
    const latestContextAt = new Map<string, number>();
    const seen = new Set(indexes.flatMap(item => item.index.seenHints));
    for (const [file, context] of scan.contexts) activity.set(file, context.activityAt);
    for (const { index } of indexes) {
      const key = index.sessionFile ?? index.sessionId;
      activity.set(key, Math.max(activity.get(key) ?? 0, index.activityAt));
      if (!index.closed && alive(index.ownerPid) && index.contextConfirmed) {
        const refs = liveContexts.get(key) ?? new Set<string>();
        for (const ref of index.references) refs.add(ref);
        liveContexts.set(key, refs);
        latestContextAt.set(key, Math.max(latestContextAt.get(key) ?? -1, index.contextAt));
      }
    }
    if (indexes.some(({ index }) => {
      const key = index.sessionFile ?? index.sessionId;
      return index.uncertain && (latestContextAt.get(key) ?? -1) < (index.uncertainAt ?? Math.max(index.contextAt, index.activityAt))
        && (!index.closed || now - (activity.get(key) ?? index.activityAt) < LOG_MAX_AGE_MS);
    })) { report.skippedUnknown = true; return report; }
    const references = new Set<string>();
    for (const [file, context] of scan.contexts) {
      if (now - (activity.get(file) ?? context.activityAt) < LOG_MAX_AGE_MS) {
        const ownConfirmed = !this.closed && file === this.state.sessionFile && this.state.contextConfirmed;
        for (const ref of ownConfirmed ? this.state.references : context.references) references.add(ref);
        for (const ref of liveContexts.get(file) ?? []) references.add(ref);
      }
    }
    for (const { index } of indexes) {
      const key = index.sessionFile ?? index.sessionId;
      const inFlight = !index.closed && alive(index.ownerPid) && index.inFlight;
      const superseded = index.closed && (latestContextAt.get(key) ?? -1) >= index.contextAt;
      if (inFlight || (!superseded && now - (activity.get(key) ?? index.activityAt) < LOG_MAX_AGE_MS)) {
        for (const ref of index.references) references.add(ref);
      }
    }
    // 会话在异步扫描期间变化则等待下一个安全边界，不使用已经过期的引用快照。
    for (const [file, context] of scan.contexts) {
      const stat = lstatSync(file);
      if (sessionFileStamp(stat) !== context.stamp) { report.skippedUnknown = true; return report; }
    }
    if (readdirSync(this.root).filter(name => LOG_DIRECTORY_PATTERN.test(name)).sort().join("\n") !== directoryNames
      || indexes.some(item => stamp(item.path) !== item.stamp)) { report.skippedUnknown = true; return report; }
    for (const loaded of indexes) {
      if (!relevantDirectories.has(basename(loaded.directory))) continue;
      if (loaded.directory !== this.directoryPath && !loaded.index.closed && alive(loaded.index.ownerPid)) continue;
      if (stamp(loaded.path) !== loaded.stamp) continue;
      const directory = lstatSync(loaded.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || `${directory.dev}:${directory.ino}` !== loaded.directoryIdentity) continue;
      const retained: RetainedLog[] = [];
      for (const original of loaded.index.records) {
        const record = { ...original, seen: original.seen || seen.has(original.path) };
        let stat;
        try { stat = lstatSync(record.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink()) { retained.push(original); continue; }
        // 崩溃遗留的 running 标记没有终态证据，不能仅因 PID 消失就当成已完成。
        const key = loaded.index.sessionFile ?? loaded.index.sessionId;
        if (keepLog(record, activity.get(key) ?? loaded.index.activityAt, references, now)
          || !record.fileStamp || fileStamp(record.path) !== record.fileStamp) { retained.push(record); continue; }
        unlinkSync(record.path); report.deleted++;
        loaded.index.collected = [...loaded.index.collected ?? [], { path: record.path, at: now, finishedAt: record.endedAt }]
          .sort((left, right) => (right.finishedAt ?? right.at) - (left.finishedAt ?? left.at)).slice(0, 20);
      }
      loaded.index.records = retained;
      if (loaded.directory === this.directoryPath) {
        this.state.records = retained;
        this.state.collected = loaded.index.collected;
        this.state.seenHints = this.state.seenHints.filter(path => existsSync(path));
        this.persist();
      } else writeIndex(loaded.path, loaded.index);
      const key = loaded.index.sessionFile ?? loaded.index.sessionId;
      const superseded = loaded.index.closed && (latestContextAt.get(key) ?? -1) >= loaded.index.contextAt;
      if (!retained.length && (loaded.index.closed || !alive(loaded.index.ownerPid))
        && (superseded || now - (activity.get(key) ?? loaded.index.activityAt) >= LOG_MAX_AGE_MS || (!loaded.index.references.length && !loaded.index.seenHints.length))
        && readdirSync(loaded.directory).every(name => name === LOG_INDEX_NAME)) {
        unlinkSync(loaded.path); rmdirSync(loaded.directory); report.removedDirectories++;
      }
    }
    if (legacy.length) {
      const open = this.openLogProbe();
      if (!open.complete) report.skippedUnknown = true;
      else for (const log of legacy) {
        if (open.paths.has(log.path) || references.has(log.path) || references.has(log.directory)
          || existsSync(join(log.directory, LOG_INDEX_NAME)) || !unchangedLegacyLog(log, now)) continue;
        unlinkSync(log.path); report.deleted++;
        if (!readdirSync(log.directory).length) { rmdirSync(log.directory); report.removedDirectories++; }
      }
    }
    return report;
  }
}
