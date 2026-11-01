import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "./errors";
export interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface OperationalDB {
  prepare(sql: string): Statement;
  batch?(statements: Statement[]): Promise<unknown>;
}
export type RuntimeEnv = Record<string, unknown> & { DB?: OperationalDB };
const runtime = new AsyncLocalStorage<RuntimeEnv>();
export function runWithIdeaRuntime<T>(env: RuntimeEnv, fn: () => T): T {
  return runtime.run(env, fn);
}
export function envValue(key: string): string | undefined {
  const value = runtime.getStore()?.[key] ?? process.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export interface NotionConfig {
  token: string;
  version: string;
  ideas: string;
  sources: string;
  evaluations: string;
  reviews: string;
}
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function notionConfig(): NotionConfig {
  const token = envValue("NOTION_TOKEN");
  if (!token)
    throw new AppError(
      "NOTION_TOKEN_REQUIRED",
      "Add the Notion connection token to the Site's protected runtime settings.",
    );
  const ids = ["IDEAS", "SOURCES", "EVALUATIONS", "REVIEWS"].map((k) =>
    envValue("NOTION_" + k + "_DATA_SOURCE_ID"),
  );
  if (ids.some((id) => !id || !idPattern.test(id)))
    throw new AppError(
      "NOTION_CONFIGURATION_REQUIRED",
      "The Notion data-source settings are incomplete.",
    );
  return {
    token,
    version: envValue("NOTION_API_VERSION") ?? "2026-03-11",
    ideas: ids[0]!.toLowerCase(),
    sources: ids[1]!.toLowerCase(),
    evaluations: ids[2]!.toLowerCase(),
    reviews: ids[3]!.toLowerCase(),
  };
}
export function operationalDB(): OperationalDB {
  const db = runtime.getStore()?.DB;
  if (!db?.prepare)
    throw new AppError(
      "WRITE_COORDINATOR_REQUIRED",
      "Saving is unavailable until the Site's operation ledger is configured.",
    );
  return db;
}
export function configurationStatus() {
  return {
    hasToken: Boolean(envValue("NOTION_TOKEN")),
    hasOwner: Boolean(
      envValue("IDEA_LAB_OWNER_USER_ID") || envValue("IDEA_LAB_OWNER_EMAIL"),
    ),
    hasCoordinator: Boolean(runtime.getStore()?.DB?.prepare),
  };
}
