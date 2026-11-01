import { envValue } from "./ideas/runtime";
export function workspaceLinks() {
  const names = ["Ideas", "Idea Sources", "Idea Evaluations", "Review Queue"];
  const keys = [
    "NOTION_IDEAS_URL",
    "NOTION_SOURCES_URL",
    "NOTION_EVALUATIONS_URL",
    "NOTION_REVIEWS_URL",
  ];
  const links = names.map((name, n) => ({
    name,
    url: safeNotionUrl(envValue(keys[n])),
  }));
  return { hub: safeNotionUrl(envValue("NOTION_HUB_URL")), databases: links };
}
function safeNotionUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["app.notion.com", "www.notion.so", "notion.so"].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
