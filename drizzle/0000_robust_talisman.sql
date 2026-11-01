CREATE TABLE `idea_lab_operation_locks` (
	`target` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `idea_lab_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_hash` text NOT NULL,
	`payload_hash` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`expected_revision` text,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`result_id` text,
	`created_at` integer NOT NULL
);
