CREATE TABLE `idea_lab_semantic_active` (
	`owner_hash` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`activated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `idea_lab_semantic_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_hash` text NOT NULL,
	`logical_profile` text NOT NULL,
	`cache_profile` text NOT NULL,
	`fields_json` text NOT NULL,
	`manifest_json` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`descriptor_json` text NOT NULL,
	`context_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `semantic_snapshot_owner_expiry` ON `idea_lab_semantic_snapshots` (`owner_hash`,`expires_at`);