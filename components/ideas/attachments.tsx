"use client";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, Paperclip, RefreshCw, Upload, X } from "lucide-react";
import {
  fileAccept,
  inspectFile,
  imageType,
  type Attachment,
  type FileMetadata,
} from "@/lib/attachments/model";
import { useResource } from "./use-resource";
import { Failure, Loading } from "./states";

type Review = {
  approvalToken: string;
  operationId: string;
  expires: number;
  title: string;
  file: FileMetadata;
  contentType: string;
};
type Pending = { id: string; status: string; created_at: number };
type Collection = { attachments: Attachment[]; pending: Pending[] };
async function action(name: string, body: unknown, multipart = false) {
  const response = await fetch("/api/attachments/" + name, {
    method: "POST",
    headers: multipart ? undefined : { "Content-Type": "application/json" },
    body: multipart ? (body as FormData) : JSON.stringify(body),
  });
  const result: any = await response.json().catch(() => null);
  if (!response.ok || !result?.data)
    throw new Error(
      result?.error?.message ??
        "The attachment request did not complete. Check upload status before trying again.",
    );
  return result.data;
}
export function Attachments({
  ideaId,
  readOnly = false,
  onSaved,
}: {
  ideaId: string;
  readOnly?: boolean;
  onSaved: () => void;
}) {
  const { data, error, loading, refresh, stale } = useResource<Collection>(
    "/api/attachments/list?ideaId=" + ideaId,
  );
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<string | null>(null),
    [review, setReview] = useState<Review | null>(null),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [operation, setOperation] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    let url: string | null = null;
    try {
      if (imageType(file.name)) url = URL.createObjectURL(file);
    } catch {}
    setPreview(url);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);
  function clear() {
    setFile(null);
    setReview(null);
    setApproved(false);
    if (input.current) input.current.value = "";
  }
  async function prepare() {
    if (!file || busy) return;
    setBusy(true);
    setMessage("");
    setApproved(false);
    try {
      const metadata = await inspectFile(file);
      setReview(await action("prepare", { ideaId, file: metadata }));
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "The file could not be reviewed.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function upload() {
    if (!review || !file || !approved || busy) return;
    const current = review;
    setBusy(true);
    setOperation(current.operationId);
    setMessage("");
    // Consume the local review immediately: uncertain network results cannot replay it.
    setReview(null);
    setApproved(false);
    try {
      const form = new FormData();
      form.append("approvalToken", current.approvalToken);
      form.append("file", file);
      const result = await action("commit", form, true);
      if (result.status !== "done")
        throw new Error(
          "The upload needs a status check before another attempt.",
        );
      clear();
      setOperation(null);
      setMessage("Attachment saved in Notion.");
      onSaved();
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "Upload not confirmed. Check its status before trying again.",
      );
    } finally {
      setBusy(false);
      refresh();
    }
  }
  async function check(id: string) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await action("status", { operationId: id });
      if (result.status === "done") {
        clear();
        setOperation(null);
        setMessage(
          "Attachment confirmed in Notion. No second upload was made.",
        );
        onSaved();
      } else if (["failed", "pending", "cancelled"].includes(result.status)) {
        setOperation(null);
        setMessage(
          "No attachment was saved by this attempt. Review the file again to retry.",
        );
      } else
        setMessage(
          "The attachment outcome is unresolved. Inspect the canonical Notion page before retrying; a missing result does not prove the upload failed.",
        );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Upload status is unavailable.",
      );
    } finally {
      setBusy(false);
      refresh();
    }
  }
  const pending = data?.pending ?? [];
  const unresolved = !!operation || pending.length > 0;
  return (
    <section
      className="panel prose-panel attachments-panel"
      aria-label="Images and files"
    >
      <div className="attachment-heading">
        <div>
          <div className="eyebrow">
            <Paperclip size={14} /> SUPPORTING MATERIAL
          </div>
          <h2>Images & files</h2>
        </div>
        <button
          className="site-secondary"
          disabled={busy || loading}
          onClick={refresh}
          aria-label="Refresh attachments"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <p>
        Add sketches, screenshots, references or documents to this idea.
        Attachments live on its Notion page.
      </p>
      {error ? (
        <Failure error={error} retry={refresh} stale={stale} />
      ) : !data ? (
        <Loading />
      ) : data.attachments.length ? (
        <div className="attachment-grid">
          {data.attachments.map((a) => (
            <article className="attachment-card" key={a.id}>
              {a.kind === "image" ? (
                <a href={a.url} target="_blank" rel="noreferrer">
                  <img
                    src={a.url}
                    alt={a.name}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                </a>
              ) : (
                <div className="attachment-file-icon">
                  <Paperclip size={28} />
                </div>
              )}
              <strong>{a.name}</strong>
              <a
                className="text-link"
                href={a.url}
                target="_blank"
                rel="noreferrer"
              >
                {a.kind === "image" ? "Open image" : "Open / download file"}
              </a>
            </article>
          ))}
        </div>
      ) : (
        <p className="subtle-note">No images or files attached yet.</p>
      )}
      {data?.attachments.length ? (
        <p className="subtle-note">
          Refresh attachments if a Notion file link has expired. Files added
          directly to the top level of this Notion page also appear here.
        </p>
      ) : null}
      {message && (
        <div className="notice" role="status">
          <p>{message}</p>
        </div>
      )}
      {pending.map((p) => (
        <div className="notice" key={p.id}>
          <p>
            An earlier upload needs checking ·{" "}
            {new Date(p.created_at).toLocaleString()}
          </p>
          <button
            className="site-secondary"
            disabled={busy}
            onClick={() => check(p.id)}
          >
            Check upload
          </button>
        </div>
      ))}
      {operation && !pending.some((p) => p.id === operation) && (
        <button
          className="site-secondary"
          disabled={busy}
          onClick={() => check(operation)}
        >
          Check upload
        </button>
      )}
      {!readOnly && (
        <div className="attachment-upload">
          <label htmlFor={"idea-file-" + ideaId}>
            <ImagePlus size={17} /> Choose an image or file
          </label>
          <input
            ref={input}
            id={"idea-file-" + ideaId}
            type="file"
            accept={fileAccept}
            disabled={busy || unresolved || !!error || !data}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setReview(null);
              setApproved(false);
              setMessage("");
            }}
          />
          <p className="subtle-note">
            Up to 5 MB per file. PNG, JPEG, GIF, WebP, PDF, text/Markdown, CSV,
            JSON, ZIP and Office documents. Choosing a file stays local.
            Uploading sends it through Idea Lab to Notion after your approval;
            no AI analysis is performed.
          </p>
          {file && (
            <div className="attachment-selected">
              {preview && (
                <img
                  className="attachment-local-preview"
                  src={preview}
                  alt={"Selected: " + file.name}
                />
              )}
              <p>
                <strong>{file.name}</strong> · {(file.size / 1024).toFixed(1)}{" "}
                KB
              </p>
              {!review && (
                <div className="action-row">
                  <button
                    className="site-primary"
                    disabled={busy || unresolved}
                    onClick={prepare}
                  >
                    Review attachment
                  </button>
                  <button
                    className="site-secondary"
                    disabled={busy}
                    onClick={clear}
                  >
                    <X size={14} /> Clear selection
                  </button>
                </div>
              )}
            </div>
          )}
          {review && (
            <div className="attachment-review">
              <h3>Attach to “{review.title}”</h3>
              <dl>
                <div>
                  <dt>File</dt>
                  <dd>{review.file.name}</dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>{review.file.size.toLocaleString()} bytes</dd>
                </div>
                <div>
                  <dt>Type</dt>
                  <dd>{review.contentType}</dd>
                </div>
              </dl>
              <p>
                The complete selected file will be stored on this idea’s Notion
                page. Its existing content and scores are preserved. This review
                expires in five minutes.
              </p>
              <label className="attachment-consent">
                <input
                  type="checkbox"
                  checked={approved}
                  disabled={busy}
                  onChange={(e) => setApproved(e.target.checked)}
                />{" "}
                I reviewed this file and approve uploading it to this idea in
                Notion.
              </label>
              <div className="action-row">
                <button
                  className="site-primary"
                  disabled={!approved || busy || unresolved}
                  onClick={upload}
                >
                  <Upload size={14} /> Approve and upload
                </button>
                <button
                  className="site-secondary"
                  disabled={busy}
                  onClick={() => {
                    setReview(null);
                    setApproved(false);
                  }}
                >
                  Back
                </button>
              </div>
            </div>
          )}
          {busy && (
            <p role="status">
              Working… Keep this page open while the upload completes.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
