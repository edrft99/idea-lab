import { describe, it, expect, vi } from "vitest";
import { IdeaDeletion } from "../lib/ideas/deletion";
import { NotionRepository } from "../lib/ideas/notion";
import { Operations, digest } from "../lib/ideas/operations";
import { AppError } from "../lib/ideas/errors";
import { memoryDB, idea, config, page } from "./fixtures";
function setup() {
  const db = memoryDB();
  const operations = new Operations(db.db);
  const repository = new NotionRepository(config);
  vi.spyOn(repository, "get").mockResolvedValue(idea);
  vi.spyOn(repository, "hasMergedHistory").mockResolvedValue(false);
  const trash = vi.spyOn(repository, "trashIdea").mockResolvedValue(undefined);
  const command = { id: idea.id, expectedRevision: idea.revision };
  return {
    service: new IdeaDeletion(repository, operations),
    repository,
    operations,
    trash,
    command,
  };
}
describe("reviewed idea deletion", () => {
  it("rejects expired approvals without writing", async () => {
    const { service, command, trash } = setup();
    const { approvalToken } = await service.prepare(command, "owner");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600000);
    try {
      await expect(
        service.commit(command, approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
      expect(trash).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it("blocks another deletion while an interrupted write owns the record lock", async () => {
    const { service, command, trash } = setup();
    const first = await service.prepare(command, "owner");
    const second = await service.prepare(command, "owner");
    trash.mockRejectedValue(new Error("Interrupted"));
    await expect(
      service.commit(command, first.approvalToken, "owner"),
    ).rejects.toMatchObject({ uncertain: true });
    await expect(
      service.commit(command, second.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "SAVE_BUSY" });
    expect(trash).toHaveBeenCalledTimes(1);
  });
  it("only writes after approval and replays a completed deletion without writing", async () => {
    const { service, command, trash } = setup();
    const approval = await service.prepare(command, "owner");
    expect(trash).not.toHaveBeenCalled();
    expect(approval.title).toBe(idea.title);
    expect(
      await service.commit(command, approval.approvalToken, "owner"),
    ).toEqual({ deleted: true, ideaId: idea.id });
    await service.commit(command, approval.approvalToken, "owner");
    expect(trash).toHaveBeenCalledTimes(1);
  });
  it("rejects changed payloads and another actor", async () => {
    const { service, command, trash } = setup();
    const { approvalToken } = await service.prepare(command, "owner");
    await expect(
      service.commit(
        { ...command, expectedRevision: "changed" },
        approvalToken,
        "owner",
      ),
    ).rejects.toMatchObject({ code: "INVALID_APPROVAL" });
    await expect(
      service.commit(command, approvalToken, "other"),
    ).rejects.toMatchObject({ code: "INVALID_APPROVAL" });
    expect(trash).not.toHaveBeenCalled();
  });
  it("rejects stale ideas at preparation and again after approval", async () => {
    const { service, command, repository, trash } = setup();
    await expect(
      service.prepare({ ...command, expectedRevision: "old" }, "owner"),
    ).rejects.toMatchObject({ code: "STALE_IDEA" });
    const { approvalToken } = await service.prepare(command, "owner");
    vi.mocked(repository.get).mockResolvedValue({
      ...idea,
      revision: "changed",
    });
    await expect(
      service.commit(command, approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "STALE_IDEA" });
    expect(trash).not.toHaveBeenCalled();
  });
  it("preserves merged history", async () => {
    const { service, command, repository, trash } = setup();
    vi.mocked(repository.hasMergedHistory).mockResolvedValue(true);
    await expect(service.prepare(command, "owner")).rejects.toMatchObject({
      code: "MERGED_IDEA",
    });
    expect(trash).not.toHaveBeenCalled();
  });
  it("keeps uncertain writes locked and reconciles by reading without replay", async () => {
    const { service, command, repository, trash } = setup();
    const { approvalToken } = await service.prepare(command, "owner");
    trash.mockRejectedValue(
      new AppError("WRITE_UNCERTAIN", "Interrupted", 503, undefined, true),
    );
    await expect(
      service.commit(command, approvalToken, "owner"),
    ).rejects.toMatchObject({ uncertain: true });
    await expect(
      service.commit(command, approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    vi.spyOn(repository, "page").mockResolvedValue({
      ...page(),
      object: "page",
      url: "https://notion.so/synthetic",
      in_trash: false,
    });
    expect((await service.status(approvalToken, "owner")).status).toBe(
      "uncertain",
    );
    vi.mocked(repository.page).mockResolvedValue({
      ...page(),
      object: "page",
      url: "https://notion.so/synthetic",
      in_trash: true,
    });
    expect(
      (await service.status(await digest(approvalToken), "owner", true)).status,
    ).toBe("done");
    expect(trash).toHaveBeenCalledTimes(1);
  });
  it("patches only the selected Notion page into trash", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        ...page(),
        object: "page",
        url: "https://notion.so/synthetic",
        in_trash: true,
      }),
    );
    await new NotionRepository(config, request).trashIdea(idea.id);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe(
      "https://api.notion.com/v1/pages/" + idea.id,
    );
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({
      in_trash: true,
    });
  });
});
