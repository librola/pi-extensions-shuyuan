import { closeSync, fstatSync, mkdtempSync, openSync, readSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export const DEFAULT_WAIT_SECONDS = 30;
export const MAX_LOG_BYTES = 64 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_TIMER_SECONDS = 2_147_483_647 / 1000;

export type JobStatus = "running" | "completed" | "failed" | "stopped" | "timed_out" | "output_limit";
export type JobSnapshot = {
  id: string;
  command: string;
  cwd: string;
  status: JobStatus;
  background: boolean;
  started_at: number;
  ended_at?: number;
  exit_code?: number;
  error?: string;
  output_path: string;
  output_bytes: number;
};
export interface OutputSnapshot {
  output: string;
  truncated: boolean;
  full_output_path: string;
}
interface Outcome {
  exitCode?: number | null;
  error?: Error;
}
interface Job extends JobSnapshot {
  controller: AbortController;
  done: Promise<Outcome>;
  detach(): void;
  handoff(): void;
  onData?: (data: Buffer) => void;
  returned: boolean;
  notified: boolean;
  stopReason?: "stopped" | "output_limit" | "failed";
}
export interface RunOptions {
  background?: boolean;
  timeout?: number;
  hardTimeout?: number;
  signal?: AbortSignal;
  onData?: (data: Buffer) => void;
  env?: NodeJS.ProcessEnv;
  displayCommand?: string;
}

export class Backgrounded extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super(`Command moved to background: ${jobId}`);
    this.jobId = jobId;
  }
}

export function validateSeconds(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_SECONDS)) {
    throw new Error(`${name} must be greater than 0 and at most ${MAX_TIMER_SECONDS} seconds`);
  }
}

// 状态与日志只属于一个会话实例；工厂加载本模块时不创建目录、进程或计时器。
export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly operations: BashOperations;
  private readonly onComplete: (job: JobSnapshot) => void;
  private readonly maxLogBytes: number;
  private readonly maxRunning: number;
  private logDirectory?: string;
  private closed = false;

  constructor(operations: BashOperations, onComplete: (job: JobSnapshot) => void, limits = { maxLogBytes: MAX_LOG_BYTES, maxRunning: 16 }) {
    this.operations = operations;
    this.onComplete = onComplete;
    this.maxLogBytes = limits.maxLogBytes;
    this.maxRunning = limits.maxRunning;
  }

  get active(): boolean {
    return [...this.jobs.values()].some(job => job.status === "running");
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map(job => this.snapshot(job));
  }

  get(id: string): JobSnapshot {
    return this.snapshot(this.requireJob(id));
  }

  private requireJob(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job id: ${id}. Use bash_jobs action=list.`);
    return job;
  }

  private snapshot(job: Job): JobSnapshot {
    return {
      id: job.id, command: job.command, cwd: job.cwd, status: job.status,
      background: job.background, started_at: job.started_at,
      ...(job.ended_at !== undefined ? { ended_at: job.ended_at } : {}),
      ...(job.exit_code !== undefined ? { exit_code: job.exit_code } : {}),
      ...(job.error ? { error: job.error } : {}),
      output_path: job.output_path, output_bytes: job.output_bytes,
    };
  }

  output(id: string, maxBytes = MAX_OUTPUT_BYTES): OutputSnapshot {
    const job = this.requireJob(id);
    const fd = openSync(job.output_path, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, maxBytes);
      const data = Buffer.alloc(length);
      const count = readSync(fd, data, 0, length, size - length);
      // 字节截尾可能落在 UTF-8 字符中间，跳过开头的续字节，不破坏完整日志。
      let start = 0;
      if (size > length) while (start < count && (data[start]! & 0xc0) === 0x80) start++;
      return { output: data.subarray(start, count).toString("utf8"), truncated: size > length, full_output_path: job.output_path };
    } finally {
      closeSync(fd);
    }
  }

  background(id?: string): string {
    const job = id ? this.requireJob(id) : [...this.jobs.values()].reverse().find(candidate => candidate.status === "running" && !candidate.background);
    if (!job || job.status !== "running") throw new Error("No running foreground bash command to background");
    if (job.background) return job.id;
    job.background = true;
    // 移交之后不再绑定发起轮次的取消信号，也不再向已返回的工具发送流式更新。
    job.detach();
    job.onData = undefined;
    job.handoff();
    return job.id;
  }

  returned(id: string): void {
    const job = this.requireJob(id);
    job.returned = true;
    this.notify(job);
  }

  private notify(job: Job): void {
    if (this.closed || !job.background || !job.returned || job.notified || job.status === "running") return;
    job.notified = true;
    try {
      this.onComplete(this.snapshot(job));
    } catch (error) {
      // 通知异常不能变成未捕获的微任务异常，导致整个 Pi 进程退出。
      console.error("[pi-background-bash] Completion notification failed:", error);
    } finally {
      this.prune();
    }
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter(job => job.status !== "running")
      .sort((a, b) => a.ended_at! - b.ended_at!);
    for (const old of finished.slice(0, Math.max(0, finished.length - 20))) {
      // 初始结果尚未移交或通知尚未发送时，回调仍需通过 ID 读取日志。
      if (old.notified || !old.background) this.jobs.delete(old.id);
    }
  }

  async stop(id: string): Promise<JobSnapshot> {
    const job = this.requireJob(id);
    if (job.status === "running") {
      job.stopReason = "stopped";
      job.controller.abort();
      await job.done;
    }
    return this.snapshot(job);
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    // 必须先禁止通知，再取消进程，避免完成回调唤醒已经失效的会话。
    this.closed = true;
    const running = [...this.jobs.values()].filter(job => job.status === "running");
    for (const job of running) {
      job.stopReason = "stopped";
      job.detach();
      job.controller.abort();
    }
    await Promise.all(running.map(job => job.done));
  }

  async run(command: string, cwd: string, options: RunOptions = {}): Promise<{ exitCode: number | null }> {
    if (this.closed) throw new Error("Bash job manager is closed");
    if (!command.trim()) throw new Error("command must not be empty");
    validateSeconds(options.timeout, "timeout");
    validateSeconds(options.hardTimeout, "hard_timeout");
    if (options.signal?.aborted) throw new Error("aborted");
    if ([...this.jobs.values()].filter(job => job.status === "running").length >= this.maxRunning) throw new Error(`At most ${this.maxRunning} bash jobs may run concurrently`);

    this.logDirectory ??= mkdtempSync(join(tmpdir(), "pi-background-bash-"));
    const id = `job-${randomUUID().slice(0, 8)}`;
    const outputPath = join(this.logDirectory, `${id}.log`);
    const fd = openSync(outputPath, "wx", 0o600);
    let resolveHandoff!: () => void;
    const handoff = new Promise<"background">(resolve => { resolveHandoff = () => resolve("background"); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const onAbort = () => { job.stopReason = "stopped"; controller.abort(); };
    const job: Job = {
      id, command: options.displayCommand ?? command, cwd, status: "running", background: false, started_at: Date.now(),
      output_path: outputPath, output_bytes: 0, controller,
      done: Promise.resolve({}), handoff: resolveHandoff, onData: options.onData,
      returned: false, notified: false,
      detach: () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      },
    };
    this.jobs.set(id, job);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    // 原生后端仍拥有 shell、PID 和进程树；这里只改变等待方式及日志归属。
    job.done = Promise.resolve().then(async (): Promise<Outcome> => {
      try {
        const result = await this.operations.exec(command, cwd, {
          signal: controller.signal, timeout: options.hardTimeout, env: options.env,
          onData: data => {
            if (job.status !== "running" || controller.signal.aborted) return;
            const remaining = this.maxLogBytes - job.output_bytes;
            const chunk = data.subarray(0, Math.max(0, remaining));
            try {
              // 每次仅写原生后端的一块输出，避免异步写队列无限积累；写失败立即停止命令。
              let offset = 0;
              while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
              job.output_bytes += chunk.length;
              job.onData?.(chunk);
              if (data.length > remaining) {
                job.stopReason = "output_limit";
                job.error = `Command exceeded the ${this.maxLogBytes}-byte log limit. Output: ${outputPath}`;
                controller.abort();
              }
            } catch (error) {
              job.stopReason = "failed";
              job.error = `Unable to retain command output: ${String(error)}`;
              controller.abort();
            }
          },
        });
        job.status = job.stopReason ?? (result.exitCode === 0 ? "completed" : "failed");
        if (result.exitCode !== null) job.exit_code = result.exitCode;
        return result;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        job.status = job.stopReason ?? (failure.message.startsWith("timeout:") ? "timed_out" : "failed");
        job.error ??= failure.message;
        return { error: job.stopReason === "output_limit" || job.stopReason === "failed" ? new Error(job.error) : failure };
      } finally {
        job.ended_at = Date.now();
        job.detach();
        job.onData = undefined;
        closeSync(fd);
        // 状态和日志落定后通知，完成回调可以直接查询或停止同一任务。
        queueMicrotask(() => this.notify(job));
        this.prune();
      }
    });

    if (options.background) this.background(id);
    else {
      timer = setTimeout(() => this.background(id), (options.timeout ?? DEFAULT_WAIT_SECONDS) * 1000);
      timer.unref();
    }
    const outcome = await Promise.race([job.done, handoff]);
    if (outcome === "background") throw new Backgrounded(id);
    if (outcome.error) throw outcome.error;
    return { exitCode: outcome.exitCode ?? null };
  }
}
