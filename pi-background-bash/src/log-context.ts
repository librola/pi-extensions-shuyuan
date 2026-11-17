import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildSessionProjection, convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const LOG_INDEX_NAME = ".pi-background-bash-logs.json";
export const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const LOG_DIRECTORY_PATTERN = /^pi-background-bash-[A-Za-z0-9]{6}$/;
export const LOG_FILE_PATTERN = /^job-[0-9a-f]{8}\.log$/;

/** 只识别本扩展临时根内的日志或目录引用，不解析或执行模型给出的 shell。 */
export function logReferences(value: unknown, root: string): Set<string> {
  const prefix = resolve(root).replaceAll("\\", "/") + "/pi-background-bash-";
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped + "[A-Za-z0-9]{6}(?:/job-[0-9a-f]{8}\\.log)?", "g");
  const references = new Set<string>();
  const visited = new WeakSet<object>();
  const visit = (item: unknown, depth: number) => {
    if (depth > 64) throw new Error("Log reference input exceeds the supported nesting depth");
    if (typeof item === "string") {
      // 兼顾工具参数中的原始路径和正文里 JSON 转义的 Windows 路径。
      const text = item.replaceAll("\\\\", "\\").replaceAll("\\", "/");
      const matches = [...text.matchAll(pattern)];
      for (const match of matches) references.add(resolve(match[0]));
      // 相对路径、$TMPDIR 等无法安全求值；出现已知目录名时保守保护整个目录。
      for (const match of text.matchAll(/pi-background-bash-[A-Za-z0-9]{6}(?![A-Za-z0-9])/g)) {
        if (!matches.some(absolute => match.index! >= absolute.index! && match.index! < absolute.index! + absolute[0].length)) references.add(join(resolve(root), match[0]));
      }
    } else if (item && typeof item === "object" && !visited.has(item)) {
      visited.add(item);
      for (const child of Object.values(item)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return references;
}

/** details 只是展示元数据；只扫描实际贡献给模型的 content。 */
export function transcriptReferences(messages: readonly unknown[], root: string): Set<string> {
  return logReferences(convertToLlm(messages as AgentMessage[]).map(message => message.role === "system"
    ? { content: message.content, sections: message.sections, toolsAdded: message.toolsAdded } : message.content), root);
}

export function sessionFileStamp(stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
function validateEntries(records: any[]): void {
  if (records[0]?.type !== "session" || records[0]?.version !== 3) throw new Error("Unsupported session format for log collection");
  const entries = records.slice(1);
  const byId = new Map<string, any>();
  for (const entry of entries) {
    if (typeof entry?.id !== "string" || !entry.id || byId.has(entry.id) || (entry.parentId !== null && typeof entry.parentId !== "string")) throw new Error("Unknown session entry identity");
    byId.set(entry.id, entry);
  }
  for (const entry of entries) if (entry.parentId !== null && !byId.has(entry.parentId)) throw new Error("Missing session parent entry");
  const visited = new Set<string>();
  let current = entries.at(-1);
  while (current) {
    if (visited.has(current.id)) throw new Error("Session branch contains a cycle");
    visited.add(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  for (const entry of entries) {
    if (entry.type === "compaction" && visited.has(entry.id) && entry.firstKeptEntryId !== null && !visited.has(entry.firstKeptEntryId)) throw new Error("Unknown compaction boundary");
  }
}

function activityFromText(text: string): number {
  const lines = text.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const entry = JSON.parse(lines[index]!);
    if (!["session", "message", "custom_message", "session_info", "context_edit", "compaction", "branch_summary"].includes(entry.type)) continue;
    const time = Date.parse(entry.timestamp);
    if (!Number.isFinite(time)) return Infinity;
    return time;
  }
  return Infinity;
}

export type SessionLogContext = { activityAt: number; references: Set<string>; stamp: string };
export type SessionLogScan = { contexts: Map<string, SessionLogContext>; complete: boolean };

/** 异步、按文件版本缓存压缩感知的会话上下文；未知或变化中的文件使本次回收保守跳过。 */
export class SessionLogScanner {
  private readonly cache = new Map<string, { stamp: string; activityAt: number; directories: Set<string>; context?: SessionLogContext }>();

  async scan(sessionRoot: string | undefined, logRoot: string, relevantDirectories?: ReadonlySet<string>): Promise<SessionLogScan> {
    const contexts = new Map<string, SessionLogContext>();
    if (!sessionRoot) return { contexts, complete: false };
    let complete = true;
    let bytes = 0;
    let files = 0;
    const walk = async (directory: string) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { complete = false; return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) { complete = false; continue; }
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { await walk(path); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        if (++files > 10000) { complete = false; return; }
        try {
          const stat = await lstat(path);
          const stamp = sessionFileStamp(stat);
          const cached = this.cache.get(path);
          const relevant = (directories: Set<string>) => !relevantDirectories || [...relevantDirectories].some(directory => directories.has(directory));
          if (cached?.stamp === stamp && (!relevant(cached.directories) || cached.context)) {
            contexts.set(path, cached.context ?? { activityAt: cached.activityAt, references: new Set(), stamp });
            continue;
          }
          bytes += stat.size;
          if (stat.size > 256 * 1024 * 1024 || bytes > 2 * 1024 * 1024 * 1024) { complete = false; continue; }
          const text = await readFile(path, "utf8");
          const directories = new Set([...text.matchAll(/pi-background-bash-[A-Za-z0-9]{6}/g)].map(match => match[0]));
          const activityAt = activityFromText(text);
          let context = { activityAt, references: new Set<string>(), stamp };
          if (relevant(directories)) {
            const records = text.split("\n").filter(Boolean).map(line => JSON.parse(line));
            validateEntries(records);
            const projection = buildSessionProjection(records.slice(1) as SessionEntry[]);
            context = { activityAt, references: transcriptReferences(projection.messages, logRoot), stamp };
          }
          const latest = await lstat(path);
          if (sessionFileStamp(latest) !== stamp) { complete = false; continue; }
          contexts.set(path, context);
          // 无关会话只缓存目录名；新候选日志出现时才解析其相关的上下文，避免每轮解析整个历史库。
          this.cache.set(path, { stamp, activityAt, directories, context: relevant(directories) ? context : undefined });
        } catch { complete = false; }
      }
    };
    await walk(sessionRoot);
    for (const path of this.cache.keys()) if (!contexts.has(path)) this.cache.delete(path);
    return { contexts, complete };
  }
}
