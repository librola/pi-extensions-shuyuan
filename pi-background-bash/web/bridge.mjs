const requestChannel = "pi-background-bash:rpc:v1:request";
const format = "pi-background-bash.job.v1";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
/** @param {import('./api.d.ts').BridgeHost} host @param {string} method @param {Record<string, unknown>} params */
async function rpc(host, method, params) {
  if (host.signal.aborted) throw new Error("Extension view expired");
  const reply = await host.requestEvent(requestChannel, { version: 1, method, params });
  if (host.signal.aborted) throw new Error("Extension view expired");
  if (!object(reply) || reply.version !== 1 || reply.success !== true || !object(reply.data)) {
    throw new Error(object(reply) && typeof reply.error === "string" ? reply.error : "Unsupported background-bash reply; reload the native session.");
  }
  return reply.data;
}
/** @param {import('./api.d.ts').BridgeHost} host @param {string} method @param {Record<string, unknown>} params */
async function request(host, method, params) {
  // 磁盘包版本不代表运行实例版本，每次操作都与当前会话的原生实例握手。
  const capabilities = await rpc(host, "ping", {});
  if (capabilities.sessionId !== host.sessionId || capabilities.format !== format
    || typeof capabilities.packageVersion !== "string" || !/^0\.2\./.test(capabilities.packageVersion)
    || !Array.isArray(capabilities.methods) || !capabilities.methods.includes(method)) {
    throw new Error("Compatible pi-background-bash is not loaded in this session; reload the native session.");
  }
  return rpc(host, method, params);
}

// 单文件原生 ESM；不导入任务引擎，也不读取文件或保留会话/进程状态。
export const actions = {
  /** @param {Record<string, unknown>} _input @param {import('./api.d.ts').BridgeHost} host */
  count: async (_input, host) => {
    // 复用原生 v1 的 list，只把当前后台运行数量送到浏览器，兼容已加载的 0.2.0。
    const data = await request(host, "list", {});
    if (!Array.isArray(data.jobs) || data.jobs.length > 64 || !data.jobs.every(job => object(job) && typeof job.background === "boolean" && typeof job.status === "string"
      && ["running", "completed", "failed", "stopped", "timed_out", "output_limit"].includes(job.status))) {
      throw new Error("Unsupported background-bash task list");
    }
    return { running: data.jobs.filter(job => job.background && job.status === "running").length };
  },
  /** @param {Record<string, unknown>} _input @param {import('./api.d.ts').BridgeHost} host */
  list: (_input, host) => request(host, "list", {}),
  /** @param {Record<string, unknown>} input @param {import('./api.d.ts').BridgeHost} host */
  status: (input, host) => request(host, "status", { id: input.id }),
  /** @param {Record<string, unknown>} input @param {import('./api.d.ts').BridgeHost} host */
  output: (input, host) => request(host, "output", { id: input.id, ...(input.tail !== undefined ? { tail: input.tail } : {}) }),
  /** @param {Record<string, unknown>} input @param {import('./api.d.ts').BridgeHost} host */
  stop: (input, host) => request(host, "stop", { id: input.id }),
  /** @param {Record<string, unknown>} input @param {import('./api.d.ts').BridgeHost} host */
  background: (input, host) => request(host, "background", input.id === undefined ? {} : { id: input.id }),
};
