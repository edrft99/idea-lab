import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import { runWithIdeaRuntime } from "../lib/ideas/runtime";
import { GET as list, POST as create } from "../app/api/imports/jobs/route";
import {
  GET as status,
  POST as action,
} from "../app/api/imports/jobs/[id]/[action]/route";
import { memoryDB, input } from "./fixtures";
import {
  downloadCheckpoint,
  readCheckpoint,
  proposalSchema,
} from "../lib/imports/model";
import { source as sourceFixture } from "./proposal-fixtures";
import { sourceKey, sourceRevision, sha256 } from "../lib/imports/provenance";
import { matchesJobResult } from "../lib/imports/job-proof";
import { commandSchema } from "../lib/ideas/domain";
import type { ImportJobView } from "../lib/imports/job-model";
import { setup as notionSetup, text } from "./proposal-fixtures";
import { config, ids } from "./fixtures";
const owner = {
  userId: "owner",
  email: "owner@example.test",
  displayName: "Owner",
  fullName: null,
};
const post = (body: unknown, origin = "https://idea.test") =>
  new Request("https://idea.test/api/imports/jobs", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const context = (id: string, action: string) => ({
  params: Promise.resolve({ id, action }),
});
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(owner);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("import job API boundary and private progress", () => {
  it.each(["denied source", "lost idea response"])(
    "recovers %s through the real shared API/provider path without duplicate canonical creation",
    async (fault) => {
      const s = notionSetup(),
        env = {
          DB: s.memory.db,
          IDEA_LAB_OWNER_USER_ID: "owner",
          NOTION_TOKEN: config.token,
          NOTION_IDEAS_DATA_SOURCE_ID: ids.ideas,
          NOTION_SOURCES_DATA_SOURCE_ID: ids.sources,
          NOTION_EVALUATIONS_DATA_SOURCE_ID: ids.evaluations,
          NOTION_REVIEWS_DATA_SOURCE_ID: ids.reviews,
        };
      vi.spyOn(globalThis, "fetch").mockImplementation(s.fetcher);
      const itemId = crypto.randomUUID(),
        command = { action: "create", data: input, source: sourceFixture };
      const send = (id: string, which: string, body: unknown) =>
        runWithIdeaRuntime(env, () => action(post(body), context(id, which)));
      try {
        const created = await runWithIdeaRuntime(env, async () =>
          create(
            post({
              requestKey: crypto.randomUUID(),
              items: [
                {
                  id: itemId,
                  sourceKey: await sourceKey(sourceFixture),
                  sourceRevision: await sourceRevision(sourceFixture),
                },
              ],
            }),
          ),
        );
        const job = ((await created.json()) as { data: ImportJobView }).data;
        expect(s.events).toHaveLength(0);
        const reviewed = await send(job.id, "prepare", { itemId, command });
        expect(reviewed.status).toBe(200);
        const receipt = (
          (await reviewed.json()) as { data: { approvalToken: string } }
        ).data;
        expect(s.writes()).toHaveLength(0);
        if (fault === "denied source") s.faults.denyCreate = ids.sources;
        else s.faults.lostCreate = ids.ideas;
        expect(
          (
            await send(job.id, "commit", {
              itemId,
              command,
              approvalToken: receipt.approvalToken,
            })
          ).status,
        ).toBe(503);
        s.faults.denyCreate = "";
        const recovery = await send(job.id, "recover-review", {
          itemId,
          command,
        });
        expect(recovery.status).toBe(200);
        const approval = (
          (await recovery.json()) as { data: { approvalToken: string } }
        ).data;
        expect(
          (
            await send(job.id, "recover", {
              itemId,
              command,
              approvalToken: approval.approvalToken,
            })
          ).status,
        ).toBe(200);
        const count = s.writes().length;
        expect(
          (
            await send(job.id, "commit", {
              itemId,
              command,
              approvalToken: receipt.approvalToken,
            })
          ).status,
        ).toBe(200);
        expect(s.writes()).toHaveLength(count);
        expect(s.writes(ids.ideas)).toHaveLength(1);
        expect(
          [...s.rows.values()].filter(
            (r) => r.parent.data_source_id === ids.sources,
          ),
        ).toHaveLength(1);
        expect(
          text(s.rows.get(ids.source).properties["Extracted Summary"]),
        ).toBe(sourceFixture.evidence);
        expect(
          s.rows.get(ids.source).properties["Related Idea"].relation,
        ).toEqual([{ id: ids.idea }]);
        const checked = await send(job.id, "check", { itemId });
        expect(checked.status).toBe(200);
        expect(
          ((await checked.json()) as { data: ImportJobView }).data.items[0]
            .status,
        ).toBe("done");
        expect(
          (
            await s.memory.db
              .prepare("SELECT * FROM idea_lab_operation_locks")
              .all()
          ).results,
        ).toHaveLength(0);
      } finally {
        s.memory.close();
      }
    },
  );
  it("guards all mutations with owner identity and same-origin JSON before any external access", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    for (const handler of [
      (r: Request) => create(r),
      (r: Request) => action(r, context(crypto.randomUUID(), "commit")),
    ]) {
      vi.mocked(getChatGPTUser).mockResolvedValue(null);
      expect(
        (
          await runWithIdeaRuntime({ IDEA_LAB_OWNER_USER_ID: "owner" }, () =>
            handler(post({})),
          )
        ).status,
      ).toBe(401);
      vi.mocked(getChatGPTUser).mockResolvedValue({
        ...owner,
        userId: "other",
      });
      expect(
        (
          await runWithIdeaRuntime({ IDEA_LAB_OWNER_USER_ID: "owner" }, () =>
            handler(post({})),
          )
        ).status,
      ).toBe(403);
      vi.mocked(getChatGPTUser).mockResolvedValue(owner);
      expect(
        (
          await runWithIdeaRuntime({ IDEA_LAB_OWNER_USER_ID: "owner" }, () =>
            handler(post({}, "https://evil.test")),
          )
        ).status,
      ).toBe(403);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("creates, lists, pauses and resumes durable metadata without sending text or requiring a Notion key", async () => {
    const m = memoryDB(),
      env = { DB: m.db, IDEA_LAB_OWNER_USER_ID: "owner" },
      fetcher = vi.spyOn(globalThis, "fetch");
    try {
      const id = crypto.randomUUID(),
        manifest = {
          requestKey: crypto.randomUUID(),
          items: [
            {
              id,
              sourceKey: await sourceKey(sourceFixture),
              sourceRevision: await sourceRevision(sourceFixture),
            },
          ],
        };
      const r = await runWithIdeaRuntime(env, () => create(post(manifest)));
      expect(r.status).toBe(200);
      const job = ((await r.json()) as { data: ImportJobView }).data;
      expect(r.headers.get("Cache-Control")).toBe("private, no-store");
      expect(JSON.stringify(job)).not.toContain(sourceFixture.evidence);
      expect((await runWithIdeaRuntime(env, () => list())).status).toBe(200);
      expect(
        (
          await runWithIdeaRuntime(env, () =>
            status(new Request("https://idea.test"), context(job.id, "status")),
          )
        ).status,
      ).toBe(200);
      for (const name of ["pause", "resume", "cancel"]) {
        const response = await runWithIdeaRuntime(env, () =>
          action(post({}), context(job.id, name)),
        );
        expect(response.status).toBe(200);
      }
      const malformed = await runWithIdeaRuntime(env, () =>
        create(
          post({
            ...manifest,
            approvalToken: "x",
            history: "must not be accepted",
          }),
        ),
      );
      expect(malformed.status).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      m.close();
    }
  });
  it("preserves only a non-authorizing job reference in private progress v3 and rejects forged completion", async () => {
    const proposal = proposalSchema.parse({
        id: crypto.randomUUID(),
        data: input,
        source: sourceFixture,
      }),
      id = crypto.randomUUID();
    const raw = downloadCheckpoint([proposal], id),
      saved = readCheckpoint(raw);
    expect(saved.version).toBe(3);
    expect(saved.jobId).toBe(id);
    expect(raw).not.toContain("approvalToken");
    expect(raw).not.toContain("lease_hash");
    expect(readCheckpoint(downloadCheckpoint([proposal])).version).toBe(2);
    const item: ImportJobView["items"][number] = {
      id: proposal.id,
      sourceKey: await sourceKey(sourceFixture),
      sourceRevision: await sourceRevision(sourceFixture),
      status: "done",
      phase: "source_confirmed",
      attempts: 1,
      attemptLimit: 3,
      notBefore: null,
      lastCode: null,
      ideaId: crypto.randomUUID(),
      operationId: "a".repeat(64),
      payloadHash: await sha256(
        JSON.stringify(
          commandSchema.parse({
            action: "create",
            data: input,
            source: sourceFixture,
          }),
        ),
      ),
      leaseActive: false,
      recoverable: false,
    };
    expect(await matchesJobResult(item, proposal)).toBe(true);
    expect(
      await matchesJobResult(item, {
        ...proposal,
        data: { ...input, title: "Altered file title" },
      }),
    ).toBe(false);
    expect(
      await matchesJobResult({ ...item, payloadHash: null }, proposal),
    ).toBe(false);
    expect(
      await matchesJobResult(item, {
        ...proposal,
        source: { ...sourceFixture, evidence: "Altered evidence" },
      }),
    ).toBe(false);
  });
});
