import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RPC_REPLY_PREFIX, RPC_REQUEST } from "../src/rpc.ts";

export function rpc(events: ExtensionAPI["events"], method: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { remove(); reject(new Error("RPC test reply timed out")); }, 2000);
    const remove = events.on(RPC_REPLY_PREFIX + requestId, response => { clearTimeout(timer); remove(); resolve(response as Record<string, any>); });
    events.emit(RPC_REQUEST, { requestId, version: 1, method, params, ...extra });
  });
}
