import { lstatSync, readlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIRECTORY_PATTERN, LOG_FILE_PATTERN, LOG_INDEX_NAME, LOG_MAX_AGE_MS } from "./log-context.ts";

export type LegacyLog = { path: string; directory: string; directoryInode: number; directoryDevice: number; inode: number; device: number; size: number; mtime: number; ctime: number };
export type OpenLogScan = { paths: Set<string>; complete: boolean };

/** 旧日志没有已读索引，只有文件自身至少七天且属于本用户时才进入候选。 */
export function legacyLogCandidates(root: string, now: number): LegacyLog[] {
  const candidates: LegacyLog[] = [];
  for (const name of readdirSync(root)) {
    if (!LOG_DIRECTORY_PATTERN.test(name)) continue;
    const directory = join(root, name);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) continue;
    const entries = readdirSync(directory);
    if (entries.includes(LOG_INDEX_NAME) || entries.some(entry => !LOG_FILE_PATTERN.test(entry))) continue;
    for (const entry of entries) {
      const path = join(directory, entry);
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink() || (process.getuid && file.uid !== process.getuid())) continue;
      if (now - Math.max(file.mtimeMs, file.ctimeMs) < LOG_MAX_AGE_MS) continue;
      candidates.push({ path, directory, directoryInode: stat.ino, directoryDevice: stat.dev, inode: file.ino, device: file.dev, size: file.size, mtime: file.mtimeMs, ctime: file.ctimeMs });
    }
  }
  return candidates;
}

/** 同 UID 的正常日志写入者持有 fd 到任务结束；任一自有进程无法检查时不删除旧日志。 */
export function openLegacyLogs(root: string): OpenLogScan {
  const paths = new Set<string>();
  if (process.platform !== "linux" || !process.getuid) return { paths, complete: false };
  let complete = true;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const directory = join("/proc", name);
    try {
      if (lstatSync(directory).uid !== process.getuid()) continue;
      for (const fd of readdirSync(join(directory, "fd"))) {
        try {
          const path = readlinkSync(join(directory, "fd", fd));
          if (path.startsWith(root + "/pi-background-bash-")) paths.add(path.replace(/ \(deleted\)$/, ""));
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false; }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false; }
  }
  return { paths, complete };
}

/** 删除前核对 inode、年龄和版本；被替换或仍在写入的文件不属于原候选。 */
export function unchangedLegacyLog(log: LegacyLog, now: number): boolean {
  try {
    const directory = lstatSync(log.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.ino !== log.directoryInode || directory.dev !== log.directoryDevice) return false;
    const stat = lstatSync(log.path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.ino === log.inode && stat.dev === log.device
      && stat.size === log.size && stat.mtimeMs === log.mtime && stat.ctimeMs === log.ctime
      && now - Math.max(stat.mtimeMs, stat.ctimeMs) >= LOG_MAX_AGE_MS;
  } catch { return false; }
}
