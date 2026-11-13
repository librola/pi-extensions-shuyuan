import type * as React from "react";
import type { JobSnapshot } from "../src/jobs.ts";

// 本插件使用的 Web API v1 子集；仅用于类型检查，不作为额外运行时 SDK。
export type Job = JobSnapshot;
export type HistoryEntry = { id: string; type: string; message?: Record<string, unknown>; omitted?: boolean };
export type JobRecord = { job: Job; origin: "history" | "live"; output?: string; truncated?: boolean };
export interface ViewContext {
  sessionId: string | null;
  cwd: string | null;
  leafId: string | null;
  signal: AbortSignal;
  readEntries(options?: { before?: string; tail?: number; customTypes?: string[]; messageRoles?: string[] }): Promise<{ entries: HistoryEntry[]; nextBefore: string | null; leafId: string | null }>;
  readCapabilities(): Promise<{ active: boolean; commands: string[]; events: string[] }>;
  invokeAction(name: string, input: unknown): Promise<{ result: unknown; leafId: string | null }>;
  ui: { openPanel(id: string): void };
}
export type ToolProps = { context: ViewContext; tool: { toolName: string }; result?: { details?: unknown }; defaultView: React.ReactNode };
export type MessageProps = { context: ViewContext; message: { role: string; customType?: string; details?: unknown; content?: unknown }; defaultView: React.ReactNode };
export interface WebHost {
  apiVersion: number;
  react: typeof React;
  extension: { assetBaseUrl: string };
  registerToolbarItem(input: { id: string; title: string; component: React.ComponentType<{ context: ViewContext }> }): () => void;
  registerToolRenderer(input: { id: string; title: string; match(props: Pick<ToolProps, "tool" | "result">): boolean; component: React.ComponentType<ToolProps> }): () => void;
  registerMessageRenderer(input: { id: string; title: string; match(props: Pick<MessageProps, "message">): boolean; component: React.ComponentType<MessageProps> }): () => void;
  registerWebCommand?(input: { name: string; description: string; run(input: { args: string; context: ViewContext }): void | Promise<void> }): () => void;
}
export interface BridgeHost {
  sessionId: string | null;
  signal: AbortSignal;
  requestEvent(name: string, payload: Record<string, unknown>): Promise<unknown>;
}
