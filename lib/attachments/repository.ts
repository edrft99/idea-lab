import { NotionRepository } from "../ideas/notion";
import { uuid } from "../ideas/domain";
import { AppError } from "../ideas/errors";
import {
  contentType,
  imageType,
  type FileMetadata,
  type Attachment,
} from "./model";

const receipt = (ideaId: string, operation: string) =>
  `https://idea-lab.edrft.chatgpt.site/ideas/${ideaId}?attachment=${operation}`;
export class AttachmentRepository {
  constructor(
    readonly ideas: NotionRepository,
    private request: typeof fetch = fetch,
  ) {}
  async blocks(ideaId: string): Promise<any[]> {
    const all: any[] = [],
      seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const raw = await this.ideas.call(
        `blocks/${ideaId}/children?page_size=100${cursor ? "&start_cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      if (!Array.isArray(raw.results))
        throw new AppError(
          "NOTION_RESPONSE_INVALID",
          "Notion returned invalid page content.",
        );
      all.push(...raw.results);
      if (!raw.has_more) return all;
      if (
        typeof raw.next_cursor !== "string" ||
        !raw.next_cursor ||
        seen.has(raw.next_cursor)
      )
        throw new AppError(
          "NOTION_PAGINATION_INVALID",
          "Notion returned invalid page pagination.",
        );
      cursor = raw.next_cursor;
      seen.add(cursor!);
    } while (all.length < 1000);
    throw new AppError(
      "ATTACHMENT_READ_LIMIT",
      "This idea has too many page blocks for a complete attachment check. Open its canonical Notion record.",
    );
  }
  decode(block: any): Attachment | null {
    if (
      !uuid.safeParse(block.id).success ||
      block.archived ||
      block.in_trash ||
      !["image", "file"].includes(block.type)
    )
      return null;
    const value = block[block.type];
    // Never embed external files or follow links from page content.
    if (value?.type !== "file") return null;
    const url = value.file?.url;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password)
        return null;
    } catch {
      return null;
    }
    if (typeof url !== "string") return null;
    const caption = (value.caption ?? [])
      .map((x: any) => x.plain_text ?? x.text?.content ?? "")
      .join("");
    return {
      id: block.id,
      name:
        value.name || caption || (block.type === "image" ? "Image" : "File"),
      kind: block.type,
      url,
      expiresAt: value.file.expiry_time ?? null,
    };
  }
  async list(ideaId: string) {
    await this.ideas.getSemanticIdea(ideaId);
    return (await this.blocks(ideaId))
      .map((b) => this.decode(b))
      .filter((x): x is Attachment => x !== null);
  }
  async find(ideaId: string, operation: string) {
    const matches = (await this.blocks(ideaId)).filter((b) => {
      const value = b[b.type];
      return (
        !b.archived &&
        !b.in_trash &&
        ["image", "file"].includes(b.type) &&
        value?.type === "file" &&
        (value.caption ?? []).some(
          (x: any) =>
            (x.href ?? x.text?.link?.url) === receipt(ideaId, operation),
        )
      );
    });
    if (matches.length > 1)
      throw new AppError(
        "ATTACHMENT_CONFLICT",
        "Multiple blocks share this attachment receipt. Inspect the Notion page before uploading again.",
        409,
        undefined,
        true,
      );
    return matches[0] ? this.decode(matches[0]) : null;
  }
  async upload(file: File, metadata: FileMetadata) {
    const created = await this.ideas.call("file_uploads", "POST", {
      mode: "single_part",
      filename: metadata.name,
      content_type: contentType(metadata.name),
    });
    if (!uuid.safeParse(created.id).success || created.status !== "pending")
      throw new AppError(
        "UPLOAD_INVALID",
        "Notion did not provide a valid upload slot.",
      );
    const form = new FormData();
    form.append(
      "file",
      new Blob([await file.arrayBuffer()], {
        type: contentType(metadata.name),
      }),
      metadata.name,
    );
    let response: Response;
    try {
      // Construct the fixed API URL ourselves; never follow an upload_url or redirect with credentials.
      response = await this.request(
        `https://api.notion.com/v1/file_uploads/${created.id}/send`,
        {
          method: "POST",
          body: form,
          redirect: "manual",
          cache: "no-store",
          signal: AbortSignal.timeout(45000),
          headers: {
            Authorization: "Bearer " + this.ideas.config.token,
            "Notion-Version": this.ideas.config.version,
          },
        },
      );
    } catch {
      throw new AppError(
        "UPLOAD_NOT_CONFIRMED",
        "The file upload was not confirmed. No attachment was added to the idea. Review again to retry.",
      );
    }
    if (!response.ok)
      throw new AppError(
        "UPLOAD_REJECTED",
        "Notion did not accept the file. Check its format, workspace upload limit and connection permissions. No attachment was added to the idea.",
        502,
      );
    const sent: any = await response.json().catch(() => null);
    if (
      sent?.id !== created.id ||
      sent.status !== "uploaded" ||
      Number(sent.content_length) !== metadata.size ||
      sent.content_type !== contentType(metadata.name)
    )
      throw new AppError(
        "UPLOAD_NOT_CONFIRMED",
        "Notion did not confirm the complete file. No attachment was added to the idea.",
      );
    return created.id as string;
  }
  async append(
    ideaId: string,
    uploadId: string,
    metadata: FileMetadata,
    operation: string,
  ) {
    const kind = imageType(metadata.name) ? "image" : "file";
    const raw = await this.ideas.call(`blocks/${ideaId}/children`, "PATCH", {
      children: [
        {
          object: "block",
          type: kind,
          [kind]: {
            type: "file_upload",
            file_upload: { id: uploadId },
            ...(kind === "file" ? { name: metadata.name } : {}),
            caption: [
              {
                type: "text",
                text: {
                  content: metadata.name,
                  link: { url: receipt(ideaId, operation) },
                },
              },
            ],
          },
        },
      ],
    });
    const block = raw.results?.[0],
      attachment = block && this.decode(block);
    if (
      raw.results?.length !== 1 ||
      !attachment ||
      attachment.kind !== kind ||
      !(block[kind].caption ?? []).some(
        (x: any) =>
          (x.href ?? x.text?.link?.url) === receipt(ideaId, operation),
      )
    )
      throw new AppError(
        "ATTACHMENT_UNCERTAIN",
        "Notion did not confirm the attached block. Check this upload before trying again.",
        503,
        undefined,
        true,
      );
    return attachment;
  }
}
