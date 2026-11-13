import { truncateTail, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JobManager, JobSnapshot } from "./jobs.ts";

export const PACKAGE_VERSION = "0.2.2";
export const JOB_FORMAT = "pi-background-bash.job.v1";
export const RPC_REQUEST = "pi-background-bash:rpc:v1:request";
export const RPC_REPLY_PREFIX = "pi-background-bash:rpc:v1:reply:";
export const RPC_METHODS = ["ping", "list", "status", "output", "stop", "background"] as const;

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function fields(params: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(params).some(key => !allowed.includes(key))) throw new Error("Unexpected request parameter");
}
function id(params: Record<string, unknown>): string {
  if (typeof params.id !== "string" || !/^job-[a-f0-9]{8}$/.test(params.id)) throw new Error("A valid job id is required");
  return params.id;
}
function describe(job: JobSnapshot): JobSnapshot {
  return { ...job, command: job.command.length > 200 ? `${job.command.slice(0, 200)}…` : job.command };
}

// 公共协议只开放已有任务操作，不接受任意 shell 命令、文件路径或跨会话 ID。
export function registerJobsRpc(events: ExtensionAPI["events"], jobs: JobManager, sessionId: string, changed: () => void): () => void {
  let disposed = false;
  const remove = events.on(RPC_REQUEST, async request => {
    if (disposed || !object(request) || typeof request.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(request.requestId)) return;
    const requestId = request.requestId;
    let reply: Record<string, unknown>;
    try {
      if (request.version !== 1 || typeof request.method !== "string" || !object(request.params)) throw new Error("Unsupported request format");
      fields(request, ["version", "method", "params", "requestId"]);
      const params = request.params;
      let data: unknown;
      switch (request.method) {
        case "ping":
          fields(params, []);
          data = { sessionId, packageVersion: PACKAGE_VERSION, format: JOB_FORMAT, methods: [...RPC_METHODS] };
          break;
        case "list":
          fields(params, []);
          data = { jobs: jobs.list().map(describe) };
          break;
        case "status":
          fields(params, ["id"]);
          data = { job: describe(jobs.get(id(params))) };
          break;
        case "output": {
          fields(params, ["id", "tail"]);
          const tail = params.tail ?? 200;
          if (typeof tail !== "number" || !Number.isInteger(tail) || tail < 1 || tail > 2000) throw new Error("tail must be an integer from 1 to 2000");
          const jobId = id(params);
          // JSON 转义最坏可放大六倍，16 KiB 留出宿主 128 KiB 回包限额所需空间。
          const output = jobs.output(jobId, 16 * 1024);
          const truncated = truncateTail(output.output, { maxBytes: 16 * 1024, maxLines: tail });
          data = { job: describe(jobs.get(jobId)), output: truncated.content, truncated: output.truncated || truncated.truncated, full_output_path: output.full_output_path };
          break;
        }
        case "stop":
          fields(params, ["id"]);
          data = { job: describe(await jobs.stop(id(params))) };
          changed();
          break;
        case "background": {
          fields(params, ["id"]);
          const jobId = jobs.background(params.id === undefined ? undefined : id(params));
          data = { job: describe(jobs.get(jobId)) };
          changed();
          break;
        }
        default:
          throw new Error("Unsupported job method");
      }
      reply = { version: 1, requestId, success: true, data };
    } catch (error) {
      reply = { version: 1, requestId, success: false, error: error instanceof Error ? error.message : "Job request failed" };
    }
    // HTTP 中止只取消宿主等待；生命周期清理后不能再用失效的 Pi 上下文回包。
    if (!disposed) events.emit(RPC_REPLY_PREFIX + requestId, reply);
  });
  return () => { disposed = true; remove(); };
}
