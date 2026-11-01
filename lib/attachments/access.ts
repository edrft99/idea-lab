import { repository } from "../ideas/access";
import { Operations } from "../ideas/operations";
import { operationalDB } from "../ideas/runtime";
import { AppError } from "../ideas/errors";
import { AttachmentRepository } from "./repository";
import { AttachmentService } from "./service";
import { MAX_FILE_BYTES } from "./model";
export const attachmentRepository = () =>
  new AttachmentRepository(repository());
export const attachmentService = () =>
  new AttachmentService(
    attachmentRepository(),
    new Operations(operationalDB()),
  );

export async function uploadBody(request: Request) {
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.startsWith("multipart/form-data;"))
    throw new AppError(
      "INVALID_CONTENT_TYPE",
      "Choose a file using the Idea Lab form.",
      415,
    );
  const max = MAX_FILE_BYTES + 65536;
  if (Number(request.headers.get("Content-Length")) > max)
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      "Choose a file no larger than 5 MB.",
      413,
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new AppError("INVALID_BODY", "The upload body is missing.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new AppError(
        "PAYLOAD_TOO_LARGE",
        "Choose a file no larger than 5 MB.",
        413,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": type },
      body: bytes,
    }).formData();
  } catch {
    throw new AppError("INVALID_BODY", "The upload form is invalid.", 400);
  }
  if (
    Array.from(form.keys()).length !== 2 ||
    form.getAll("file").length !== 1 ||
    form.getAll("approvalToken").length !== 1
  )
    throw new AppError(
      "INVALID_BODY",
      "Submit one file and its approval.",
      400,
    );
  const file = form.get("file"),
    token = form.get("approvalToken");
  if (
    !(file instanceof File) ||
    typeof token !== "string" ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    throw new AppError(
      "INVALID_BODY",
      "Submit one file and its approval.",
      400,
    );
  return { file, token };
}
