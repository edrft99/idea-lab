CREATE TABLE `idea_lab_claude_auth_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`state` text NOT NULL,
	`scope` text NOT NULL,
	`resource` text NOT NULL,
	`status` text NOT NULL,
	`actor_id` text,
	`actor_email` text,
	`code_hash` text,
	`code_expires_at` integer,
	`claimed_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`approved_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claude_auth_code` ON `idea_lab_claude_auth_requests` (`code_hash`);--> statement-breakpoint
CREATE INDEX `claude_auth_expiry` ON `idea_lab_claude_auth_requests` (`expires_at`);--> statement-breakpoint
CREATE TABLE `idea_lab_claude_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`client_id` text NOT NULL,
	`resource` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `claude_session_actor` ON `idea_lab_claude_sessions` (`actor_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `idea_lab_claude_tokens` (
	`access_hash` text PRIMARY KEY NOT NULL,
	`refresh_hash` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`rotated_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claude_refresh_hash` ON `idea_lab_claude_tokens` (`refresh_hash`);--> statement-breakpoint
CREATE INDEX `claude_token_session` ON `idea_lab_claude_tokens` (`session_id`);