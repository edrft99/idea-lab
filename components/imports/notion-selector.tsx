"use client";
import { useEffect, useRef, useState } from "react";
import { requestData } from "@/components/ideas/use-resource";
import { type ParsedImport } from "@/lib/imports/model";
import { type NotionRows } from "@/lib/imports/notion-model";
export function NotionSelector({
  onPreview,
}: {
  onPreview: (preview: ParsedImport) => void;
}) {
  const [mode, setMode] = useState<"page" | "data-source">("page"),
    [reference, setReference] = useState(""),
    [nested, setNested] = useState(false),
    [rows, setRows] = useState<NotionRows | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0),
    inFlight = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function submit(
    action: "page" | "list" | "rows",
    cursor: string | null = null,
  ) {
    if (inFlight.current) return;
    const current = ++generation.current;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const command =
        action === "rows"
          ? {
              action,
              dataSourceId: rows?.dataSourceId,
              pageIds: selected,
              readNested: nested,
              allowContentRead: true,
            }
          : action === "list"
            ? { action, reference, cursor, allowMetadataRead: true }
            : { action, reference, readNested: nested, allowContentRead: true };
      const response = await requestData<
        | { kind: "rows"; result: NotionRows }
        | { kind: "preview"; result: ParsedImport }
      >("/api/imports/notion", {
        method: "POST",
        body: JSON.stringify(command),
      });
      if (current !== generation.current) return;
      if (response.kind === "rows") {
        setRows(response.result);
        setSelected([]);
      } else onPreview(response.result);
    } catch (e) {
      if (current === generation.current)
        setError(
          e instanceof Error
            ? e.message
            : "This selected Notion content could not be read.",
        );
    } finally {
      if (current === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section className="panel prose-panel">
      <span className="tiny-label">OR · SELECT NOTION CONTENT</span>
      <h2>Read selected Notion pages</h2>
      <p>
        The Site reads only the page you name, or the rows you choose from one
        data source. Page text travels from Notion through the Site to this
        preview. Nothing is saved and no AI provider is called. Ancestor
        metadata is checked to exclude Idea Lab.
      </p>
      <form
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(mode === "page" ? "page" : "list");
        }}
      >
        <fieldset className="import-ready" disabled={busy}>
          <label>
            Notion selection type
            <select
              aria-label="Notion selection type"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as typeof mode);
                setRows(null);
                setSelected([]);
                setError("");
              }}
            >
              <option value="page">One page</option>
              <option value="data-source">
                Choose rows from a data source
              </option>
            </select>
          </label>
          <label>
            {mode === "page"
              ? "Notion page URL or ID"
              : "Notion data-source ID"}
            <input
              aria-label={
                mode === "page"
                  ? "Notion page URL or ID"
                  : "Notion data-source ID"
              }
              value={reference}
              maxLength={2000}
              onChange={(e) => {
                setReference(e.target.value);
                setRows(null);
                setSelected([]);
              }}
              autoComplete="off"
            />
          </label>
          <label className="turn-select">
            <input
              type="checkbox"
              checked={nested}
              onChange={(e) => setNested(e.target.checked)}
            />
            Include supported nested blocks within each chosen page
          </label>
          <button
            className="site-secondary"
            disabled={!reference.trim()}
            type="submit"
          >
            {busy
              ? "Reading…"
              : mode === "page"
                ? "Preview selected Notion page"
                : "List 25 row titles"}
          </button>
        </fieldset>
      </form>
      {rows && (
        <div className="mt-panel">
          <h3>{rows.title}</h3>
          <p>
            Choose up to five visible rows. Titles are metadata; page bodies
            load only after you choose them.
          </p>
          {rows.rows.length ? (
            rows.rows.map((row) => (
              <label key={row.id} className="turn-select">
                <input
                  type="checkbox"
                  checked={selected.includes(row.id)}
                  disabled={
                    busy || (!selected.includes(row.id) && selected.length >= 5)
                  }
                  onChange={(e) =>
                    setSelected((ids) =>
                      e.target.checked
                        ? [...ids, row.id]
                        : ids.filter((id) => id !== row.id),
                    )
                  }
                />
                <span>
                  {row.title}
                  <small> · Updated {row.revision.slice(0, 10)}</small>
                </span>
              </label>
            ))
          ) : (
            <p>No readable rows on this result page.</p>
          )}
          <div className="action-row mt-button">
            <button
              className="site-primary"
              disabled={busy || !selected.length}
              onClick={() => void submit("rows")}
            >
              Preview chosen Notion rows
            </button>
            {rows.nextCursor && (
              <button
                className="site-secondary"
                disabled={busy}
                onClick={() => void submit("list", rows.nextCursor)}
              >
                Next 25 row titles
              </button>
            )}
            <button
              className="site-secondary"
              disabled={busy}
              onClick={() => {
                generation.current++;
                setRows(null);
                setSelected([]);
                setReference("");
                setError("");
              }}
            >
              Clear Notion selection
            </button>
          </div>
        </div>
      )}
      <p className="subtle-note">
        Child pages, linked pages, synced blocks and attachments are not
        followed. Unsupported content is reported. Idea Lab cannot be imported
        into itself. Your connection must already have read access to the pages
        you select.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
