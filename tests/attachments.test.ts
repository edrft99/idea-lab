import { describe, it, expect, vi } from "vitest";
import { AttachmentService } from "../lib/attachments/service";
import { AttachmentRepository } from "../lib/attachments/repository";
import {
  inspectFile,
  verifyImageSignature,
  MAX_FILE_BYTES,
} from "../lib/attachments/model";
import { NotionRepository } from "../lib/ideas/notion";
import { Operations } from "../lib/ideas/operations";
import { config, ids, page, schema, memoryDB } from "./fixtures";

function setup() {
  const mem = memoryDB(),
    operations = new Operations(mem.db);
  const state = {
    blocks: [] as any[],
    creates: 0,
    sends: 0,
    appends: 0,
    revision: "2026-10-30T10:00:00.000Z",
    merged: false,
    lostAppend: false,
    rejectAppend: false,
    rejectUpload: false,
    redirectUpload: false,
    changedDuringUpload: false,
    invalidAppendResponse: false,
    size: 0,
    type: "",
    latestToken: "",
    body: null as FormData | null,
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url).replace("https://api.notion.com/v1/", ""),
      method = init?.method ?? "GET";
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer " + config.token,
    );
    if (path === "data_sources/" + ids.ideas) return Response.json(schema());
    if (path === "pages/" + ids.idea) {
      const p = page({ last_edited_time: state.revision });
      if (state.merged)
        p.properties["Canonical Idea"].relation = [{ id: ids.source }];
      return Response.json(p);
    }
    if (path.startsWith("blocks/" + ids.idea + "/children") && method === "GET")
      return Response.json({ results: state.blocks, has_more: false });
    if (path === "file_uploads") {
      state.creates++;
      const body = JSON.parse(init?.body as string);
      state.type = body.content_type;
      expect(body.mode).toBe("single_part");
      return Response.json({
        id: ids.source,
        status: "pending",
        upload_url: "https://attacker.example/send",
      });
    }
    if (path === "file_uploads/" + ids.source + "/send") {
      state.sends++;
      expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
      state.body = init?.body as FormData;
      const f = state.body.get("file") as File;
      state.size = f.size;
      expect(f.type).toBe(state.type);
      if (state.changedDuringUpload)
        state.revision = "2026-10-31T10:00:00.000Z";
      if (state.redirectUpload)
        return new Response(null, {
          status: 307,
          headers: { Location: "https://attacker.example" },
        });
      if (state.rejectUpload) return new Response(null, { status: 403 });
      return Response.json({
        id: ids.source,
        status: "uploaded",
        content_length: f.size,
        content_type: f.type,
      });
    }
    if (path === "blocks/" + ids.idea + "/children" && method === "PATCH") {
      state.appends++;
      if (state.rejectAppend) return new Response(null, { status: 403 });
      const b = JSON.parse(init?.body as string).children[0],
        value = b[b.type];
      const block = {
        id: ids.source,
        type: b.type,
        [b.type]: {
          ...value,
          type: "file",
          file: {
            url: "https://secure.notion-static.com/synthetic-file",
            expiry_time: "2027-01-01T00:00:00Z",
          },
        },
      };
      delete block[b.type].file_upload;
      state.blocks.push(block);
      if (state.lostAppend) throw new Error("synthetic lost response");
      return Response.json({
        results: state.invalidAppendResponse ? [] : [block],
      });
    }
    throw new Error("Unexpected synthetic request " + method + " " + path);
  });
  const repo = new AttachmentRepository(
    new NotionRepository(config, fetcher),
    fetcher,
  );
  const service = new AttachmentService(repo, operations);
  const file = new File(["Synthetic attachment content."], "reference.txt", {
    type: "text/plain",
  });
  const prepare = async () =>
    service.prepare("owner", {
      ideaId: ids.idea,
      file: await inspectFile(file),
    });
  return { ...mem, state, fetcher, repo, operations, service, file, prepare };
}
describe("reviewed Notion attachments", () => {
  it("prepares metadata only, uploads exact bytes once and preserves existing page content", async () => {
    const t = setup();
    try {
      const review = await t.prepare();
      expect(t.state.creates).toBe(0);
      expect(t.state.appends).toBe(0);
      const result = await t.service.commit(
        "owner",
        review.approvalToken,
        t.file,
      );
      expect(result.status).toBe("done");
      expect(t.state).toMatchObject({ creates: 1, sends: 1, appends: 1 });
      expect(await (t.state.body!.get("file") as File).text()).toBe(
        await t.file.text(),
      );
      await t.service.commit("owner", review.approvalToken, t.file);
      expect(t.state.appends).toBe(1);
      expect(t.state.sends).toBe(1);
      expect(
        t.fetcher.mock.calls.some(
          ([url, init]) =>
            String(url).includes("pages/") && init?.method === "PATCH",
        ),
      ).toBe(false);
      expect(await t.repo.list(ids.idea)).toHaveLength(1);
      const ledger = JSON.stringify(
        (await t.db.prepare("SELECT * FROM idea_lab_operations").all()).results,
      );
      expect(ledger).not.toContain("reference.txt");
      expect(ledger).not.toContain("Synthetic attachment content");
      expect(ledger).not.toContain("secure.notion");
    } finally {
      t.close();
    }
  });
  it("creates image blocks only for validated raster signatures", async () => {
    const t = setup();
    try {
      const file = new File(
        [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])],
        "sketch.png",
      );
      const r = await t.service.prepare("owner", {
        ideaId: ids.idea,
        file: await inspectFile(file),
      });
      await t.service.commit("owner", r.approvalToken, file);
      expect(t.state.blocks[0].type).toBe("image");
      expect((await t.repo.list(ids.idea))[0].kind).toBe("image");
    } finally {
      t.close();
    }
  });
  it.each([
    "content",
    "name",
    "owner",
    "expired",
    "action",
    "revision",
    "merged",
  ])("rejects changed %s before upload", async (change) => {
    const t = setup();
    try {
      const r = await t.prepare();
      let file = t.file,
        actor = "owner";
      if (change === "content")
        file = new File(["Changed contents, same title"], t.file.name);
      if (change === "name")
        file = new File([await t.file.arrayBuffer()], "other.txt");
      if (change === "owner") actor = "other";
      if (change === "expired")
        await t.db.prepare("UPDATE idea_lab_operations SET expires_at=0").run();
      if (change === "action")
        await t.db
          .prepare("UPDATE idea_lab_operations SET action='update'")
          .run();
      if (change === "revision") t.state.revision = "2026-10-31T00:00:00.000Z";
      if (change === "merged") t.state.merged = true;
      await expect(
        t.service.commit(actor, r.approvalToken, file),
      ).rejects.toThrow();
      expect(t.state.sends).toBe(0);
    } finally {
      t.close();
    }
  });
  it("prevents concurrent claims and other saves through the shared idea lock", async () => {
    const t = setup();
    try {
      const first = await t.prepare(),
        second = await t.prepare();
      const op = await t.operations.read(first.approvalToken, "owner");
      await t.operations.claim(op, op.payload_hash);
      await expect(
        t.service.commit("owner", second.approvalToken, t.file),
      ).rejects.toMatchObject({ code: "SAVE_BUSY" });
      await expect(
        t.service.commit("owner", first.approvalToken, t.file),
      ).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
      expect(t.state.sends).toBe(0);
    } finally {
      t.close();
    }
  });
  it.each(["lostAppend", "invalidAppendResponse"] as const)(
    "positively reconciles %s without another upload/append",
    async (fault) => {
      const t = setup();
      try {
        t.state[fault] = true;
        const r = await t.prepare();
        await expect(
          t.service.commit("owner", r.approvalToken, t.file),
        ).rejects.toMatchObject({ uncertain: true });
        expect(
          await t.operations.pendingAttachments("owner", ids.idea),
        ).toHaveLength(1);
        expect(
          await t.operations.pendingAttachments("other", ids.idea),
        ).toHaveLength(0);
        expect((await t.service.status("owner", r.operationId)).status).toBe(
          "done",
        );
        expect(
          await t.operations.pendingAttachments("owner", ids.idea),
        ).toHaveLength(0);
        expect(t.state).toMatchObject({ creates: 1, sends: 1, appends: 1 });
        await expect(
          t.service.status("other", r.operationId),
        ).rejects.toThrow();
      } finally {
        t.close();
      }
    },
  );
  it("does not unlock or replay a missing or duplicated ambiguous result", async () => {
    const t = setup();
    try {
      t.state.lostAppend = true;
      const r = await t.prepare();
      await expect(
        t.service.commit("owner", r.approvalToken, t.file),
      ).rejects.toThrow();
      const original = t.state.blocks[0];
      t.state.blocks = [];
      expect((await t.service.status("owner", r.operationId)).status).toBe(
        "uncertain",
      );
      expect(
        (await t.db.prepare("SELECT * FROM idea_lab_operation_locks").all())
          .results,
      ).toHaveLength(1);
      const second = await t.prepare();
      await expect(
        t.service.commit("owner", second.approvalToken, t.file),
      ).rejects.toThrow();
      t.state.blocks = [original, original];
      await expect(
        t.service.status("owner", r.operationId),
      ).rejects.toMatchObject({ code: "ATTACHMENT_CONFLICT" });
      expect(t.state.appends).toBe(1);
    } finally {
      t.close();
    }
  });
  it.each([
    "rejectUpload",
    "redirectUpload",
    "changedDuringUpload",
    "rejectAppend",
  ] as const)(
    "handles %s without replay and releases definitively unused locks",
    async (fault) => {
      const t = setup();
      try {
        t.state[fault] = true;
        const r = await t.prepare();
        await expect(
          t.service.commit("owner", r.approvalToken, t.file),
        ).rejects.toThrow();
        expect((await t.operations.read(r.approvalToken, "owner")).status).toBe(
          "failed",
        );
        expect(t.state.blocks).toHaveLength(0);
        expect(
          (await t.db.prepare("SELECT * FROM idea_lab_operation_locks").all())
            .results,
        ).toHaveLength(0);
        expect(
          t.fetcher.mock.calls.every(([url]) =>
            String(url).startsWith("https://api.notion.com/v1/"),
          ),
        ).toBe(true);
      } finally {
        t.close();
      }
    },
  );
  it("bounds file sizes, formats and names; rejects forged image headers", async () => {
    for (const file of [
      new File(["x"], "../bad.txt"),
      new File(["x"], "script.html"),
      new File([], "empty.txt"),
      new File([new Uint8Array(MAX_FILE_BYTES + 1)], "large.txt"),
    ])
      await expect(inspectFile(file)).rejects.toThrow();
    expect(() =>
      verifyImageSignature(
        "fake.png",
        new TextEncoder().encode("<script>not an image</script>"),
      ),
    ).toThrow();
    const t = setup();
    try {
      const fake = new File(["Not a PNG"], "fake.png"),
        r = await t.service.prepare("owner", {
          ideaId: ids.idea,
          file: await inspectFile(fake),
        });
      await expect(
        t.service.commit("owner", r.approvalToken, fake),
      ).rejects.toMatchObject({ code: "IMAGE_INVALID" });
      expect(t.state.creates).toBe(0);
    } finally {
      t.close();
    }
  });
  it("omits external, archived and unsafe attachments", async () => {
    const t = setup();
    try {
      const r = await t.prepare();
      await t.service.commit("owner", r.approvalToken, t.file);
      const b = t.state.blocks[0];
      t.state.blocks = [
        { ...b, archived: true },
        {
          ...b,
          file: {
            type: "external",
            external: { url: "https://attacker.example" },
          },
        },
        { ...b, file: { type: "file", file: { url: "javascript:alert(1)" } } },
      ];
      expect(await t.repo.list(ids.idea)).toEqual([]);
    } finally {
      t.close();
    }
  });
});
