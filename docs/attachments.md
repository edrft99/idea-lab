# Images and file attachments

Open a saved idea and use Images & files. Select one supported file (up to 5 MiB), inspect its local image preview/name/size, then request a review. Check the explicit upload approval and upload. Uploading sends the complete selected file through the private Site into Notion-managed storage, then appends an image/file block to the idea page. It does not call a model, update scores, replace page content or change the idea database schema. New ideas must be saved first.

PNG, JPEG, GIF and WebP display as images. PDF, text/Markdown, CSV, JSON, ZIP and Office documents have file links. Formats beyond this bounded allowlist, bulk uploads, removal/replacement, OCR and assistant attachment tools are outside this first version. Files added directly as top-level Notion image/file blocks also appear; nested blocks, external URLs and database file properties are not traversed. Notion may enforce a lower workspace/file-type limit and reject an upload.

Notion remains authoritative; no R2 bucket or new Site is required. Browser selection/file bytes stay local until upload approval. Preparing review sends only filename, size and SHA-256 checksum to the private Site. The operational ledger retains owner/payload hashes, target/revision, status and confirmed block ID; it does not retain filename, file bytes or signed URLs. Temporary Notion download links are re-fetched from canonical blocks when attachments are refreshed. Signed links are bearer access links and should not be shared outside the intended audience. See https://developers.notion.com/guides/data-apis/uploading-small-files.

## Approval and recovery

The five-minute receipt binds actor, target idea, revision and exact filename/size/content hash. The server checks owner, same-origin multipart submission, actual streaming size, file type, image signatures and the same content hash. One file is accepted per request. Claimed receipts and shared idea locks prevent replay/concurrent operations. Image signature checks are format checks, not antivirus scanning. Documents are never embedded/executed by the Site.

The server constructs fixed Notion API URLs, refuses redirects, sends multipart without overriding its boundary, applies request deadlines and makes no automatic mutation retries. It rechecks the idea after file transfer and before appending. Notion does not provide compare-and-swap against external writers. A rejected/pre-append attempt can be reviewed again; an unattached Notion upload may remain until its one-hour expiry. Notion does not expose a file-upload revoke/delete API.

Each appended block's filename caption links back to the idea with a unique operation receipt. A lost append response retains the idea lock. Check upload, including after reload or from Recent saves, searches the complete bounded top-level block list for that exact receipt and confirms an existing block without uploading/appending again. Missing/duplicate results remain unresolved; inspect Notion and the ledger rather than retrying blindly or unlocking. A process lost before/during append can therefore require operator inspection. No automatic unlock or automatic retry is provided.

## Verification

Use synthetic files/provider responses for automated and browser tests. Real attachment creation is a canonical Notion write and requires exact owner approval. Publication, connection capabilities and a real owner-chosen attachment are distinct rollout gates.
