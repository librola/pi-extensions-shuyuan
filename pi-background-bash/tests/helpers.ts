import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createEventBus, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

export async function until(predicate: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Test condition timed out");
    await delay(5);
  }
}

export function harness(options: { cwd?: string; sessionId?: string; mode?: "rpc" | "tui" | "print" | "json"; settings?: Record<string, unknown> } = {}) {
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "pi-background-bash-test-"));
  const tools = new Map<string, ToolDefinition<any, any>>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const messages: Array<{ message: any; options: any }> = [];
  const statuses = new Map<string, string | undefined>();
  const notifications: string[] = [];
  const mode = options.mode ?? "rpc";
  const ctx = {
    cwd, mode, hasUI: mode === "rpc" || mode === "tui",
    model: { provider: "test-provider", id: "test-model" }, thinkingLevel: "high",
    sessionManager: { getSessionId: () => options.sessionId ?? "session-test", getSessionFile: () => undefined },
    ui: { setStatus: (key: string, value?: string) => statuses.set(key, value), notify: (value: string) => notifications.push(value) },
  } as unknown as ExtensionToolContext;
  const events = createEventBus();
  const api = {
    events,
    on: (name: string, handler: (...args: any[]) => any) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {};
    },
    registerTool: (tool: ToolDefinition<any, any>) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut: (name: string, shortcut: any) => shortcuts.set(name, shortcut),
    sendMessage: (message: any, delivery: any) => messages.push({ message, options: delivery }),
    getSettings: () => options.settings ?? {},
  } as unknown as ExtensionAPI;
  extension(api);
  const emit = async (event: string, eventContext: ExtensionContext = ctx) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, reason: "startup" }, eventContext);
  };
  return {
    cwd, ctx, api, events, tools, commands, shortcuts, messages, statuses, notifications, emit,
    async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`No tool ${name}`);
      return tool.execute(randomUUID(), args, signal, undefined, ctx);
    },
    async close() {
      await emit("session_shutdown");
      if (!options.cwd) rmSync(cwd, { recursive: true, force: true });
    },
  };
}
