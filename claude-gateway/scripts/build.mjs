import { mkdir, cp, readFile } from "node:fs/promises";
const config = JSON.parse(await readFile(".openai/hosting.json", "utf8"));
if (!config.project_id)
  throw new Error(
    "Register and persist the dedicated relay Site before packaging for publication.",
  );
await mkdir("dist/server", { recursive: true });
await mkdir("dist/.openai", { recursive: true });
await cp("worker/index.js", "dist/server/index.js");
await cp(".openai/hosting.json", "dist/.openai/hosting.json");
console.log("Relay Worker artifact prepared.");
