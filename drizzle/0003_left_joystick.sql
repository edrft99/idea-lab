CREATE TABLE `idea_lab_assistant_captures` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_hash` text NOT NULL,
	`request_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`payload_hash` text NOT NULL,
	`client` text NOT NULL,
	`command_json` text,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assistant_capture_owner_expiry` ON `idea_lab_assistant_captures` (`owner_hash`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_capture_request` ON `idea_lab_assistant_captures` (`owner_hash`,`request_key`);