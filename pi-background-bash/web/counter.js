import { isObject, RPC_REQUEST } from "./parse.js";

/** 只查询已绑定实例；未知状态不能转换成 0，也不为计数启动会话。
 * @param {import('./api.d.ts').ViewContext} context @returns {Promise<number | null>}
 */
export async function readBackgroundCount(context) {
  const unavailable = () => context.signal.aborted || (typeof document !== "undefined" && document.hidden);
  if (!context.sessionId || unavailable()) return null;
  const capabilities = await context.readCapabilities();
  if (unavailable() || !capabilities.active || !capabilities.events.includes(RPC_REQUEST)) return null;
  const { result } = await context.invokeAction("count", {});
  if (unavailable() || !isObject(result)) return null;
  const value = result.running;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
