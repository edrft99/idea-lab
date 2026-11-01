import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
// Operational approval/coordination only. No idea descriptions, sources or scores.
export const operations = sqliteTable("idea_lab_operations", {
  id: text("id").primaryKey(),
  actorHash: text("actor_hash").notNull(),
  payloadHash: text("payload_hash").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  expectedRevision: text("expected_revision"),
  expiresAt: integer("expires_at").notNull(),
  status: text("status").notNull(),
  resultId: text("result_id"),
  createdAt: integer("created_at").notNull(),
});
export const operationLocks = sqliteTable("idea_lab_operation_locks", {
  target: text("target").primaryKey(),
  operationId: text("operation_id").notNull(),
});

// Rebuildable semantic cache. Contains vectors and identifiers/hashes only, never idea text or scores.
export const semanticVectors = sqliteTable(
  "idea_lab_semantic_vectors",
  {
    ownerHash: text("owner_hash").notNull(),
    profileHash: text("profile_hash").notNull(),
    ideaId: text("idea_id").notNull(),
    inputHash: text("input_hash").notNull(),
    inputRevision: text("input_revision").notNull(),
    fieldsJson: text("fields_json").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    vector: text("vector").notNull(),
    vectorHash: text("vector_hash").notNull(),
    operationId: text("operation_id").notNull(),
    updatedAt: integer("updated_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerHash, t.profileHash, t.ideaId] }),
    index("semantic_owner_operation").on(t.ownerHash, t.operationId),
    index("semantic_owner_expiry").on(t.ownerHash, t.expiresAt),
  ],
);

// Immutable rebuild manifests contain identifiers/hashes only. The pointer is the atomic search switch.
export const semanticSnapshots = sqliteTable(
  "idea_lab_semantic_snapshots",
  {
    id: text("id").primaryKey(),
    ownerHash: text("owner_hash").notNull(),
    logicalProfile: text("logical_profile").notNull(),
    cacheProfile: text("cache_profile").notNull(),
    fieldsJson: text("fields_json").notNull(),
    manifestJson: text("manifest_json").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    descriptorJson: text("descriptor_json").notNull(),
    contextHash: text("context_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("semantic_snapshot_owner_expiry").on(t.ownerHash, t.expiresAt)],
);
export const semanticActive = sqliteTable("idea_lab_semantic_active", {
  ownerHash: text("owner_hash").primaryKey(),
  snapshotId: text("snapshot_id").notNull(),
  operationId: text("operation_id").notNull(),
  activatedAt: integer("activated_at").notNull(),
});

// Temporary selected assistant drafts; never an authoritative idea store. Expiry and human approval are enforced server-side.
export const assistantCaptures = sqliteTable(
  "idea_lab_assistant_captures",
  {
    id: text("id").primaryKey(),
    ownerHash: text("owner_hash").notNull(),
    requestKey: text("request_key").notNull(),
    requestHash: text("request_hash").notNull(),
    payloadHash: text("payload_hash").notNull(),
    client: text("client").notNull(),
    commandJson: text("command_json"),
    approvedAt: integer("approved_at"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    index("assistant_capture_owner_expiry").on(t.ownerHash, t.expiresAt),
    uniqueIndex("assistant_capture_request").on(t.ownerHash, t.requestKey),
  ],
);

// Revocable OAuth grants for the separate Claude relay. Tokens and codes are stored only as hashes.
export const claudeAuthRequests = sqliteTable(
  "idea_lab_claude_auth_requests",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    state: text("state").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource").notNull(),
    status: text("status").notNull(),
    actorId: text("actor_id"),
    actorEmail: text("actor_email"),
    codeHash: text("code_hash"),
    codeExpiresAt: integer("code_expires_at"),
    claimedBy: text("claimed_by"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    approvedAt: integer("approved_at"),
  },
  (t) => [
    uniqueIndex("claude_auth_code").on(t.codeHash),
    index("claude_auth_expiry").on(t.expiresAt),
  ],
);
export const claudeSessions = sqliteTable(
  "idea_lab_claude_sessions",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    actorEmail: text("actor_email").notNull(),
    clientId: text("client_id").notNull(),
    resource: text("resource").notNull(),
    scope: text("scope").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("claude_session_actor").on(t.actorId, t.expiresAt)],
);
export const claudeTokens = sqliteTable(
  "idea_lab_claude_tokens",
  {
    accessHash: text("access_hash").primaryKey(),
    refreshHash: text("refresh_hash").notNull(),
    sessionId: text("session_id").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    rotatedBy: text("rotated_by"),
  },
  (t) => [
    uniqueIndex("claude_refresh_hash").on(t.refreshHash),
    index("claude_token_session").on(t.sessionId),
  ],
);

// Import coordination only. Selected text stays in the owner's private progress file.
export const importJobs = sqliteTable(
  "idea_lab_import_jobs",
  {
    id: text("id").primaryKey(),
    ownerHash: text("owner_hash").notNull(),
    requestKey: text("request_key").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("import_job_request").on(t.ownerHash, t.requestKey),
    index("import_job_owner_expiry").on(t.ownerHash, t.expiresAt),
  ],
);
export const importJobItems = sqliteTable(
  "idea_lab_import_job_items",
  {
    jobId: text("job_id").notNull(),
    id: text("id").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceRevision: text("source_revision").notNull(),
    status: text("status").notNull(),
    operationId: text("operation_id"),
    attempts: integer("attempts").notNull(),
    phase: text("phase").notNull(),
    leaseHash: text("lease_hash"),
    leaseUntil: integer("lease_until").notNull(),
    notBefore: integer("not_before").notNull(),
    lastCode: text("last_code"),
    ideaId: text("idea_id"),
    ideaRevision: text("idea_revision"),
    sourceId: text("source_id"),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.id] }),
    uniqueIndex("import_job_source").on(t.jobId, t.sourceKey),
    uniqueIndex("import_job_operation").on(t.operationId),
  ],
);
