CREATE TABLE `idea_lab_import_job_items` (
	`job_id` text NOT NULL,
	`id` text NOT NULL,
	`source_key` text NOT NULL,
	`source_revision` text NOT NULL,
	`status` text NOT NULL,
	`operation_id` text,
	`attempts` integer NOT NULL,
	`phase` text NOT NULL,
	`lease_hash` text,
	`lease_until` integer NOT NULL,
	`not_before` integer NOT NULL,
	`last_code` text,
	`idea_id` text,
	`idea_revision` text,
	`source_id` text,
	PRIMARY KEY(`job_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_job_source` ON `idea_lab_import_job_items` (`job_id`,`source_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `import_job_operation` ON `idea_lab_import_job_items` (`operation_id`);--> statement-breakpoint
CREATE TABLE `idea_lab_import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_hash` text NOT NULL,
	`request_key` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_job_request` ON `idea_lab_import_jobs` (`owner_hash`,`request_key`);--> statement-breakpoint
CREATE INDEX `import_job_owner_expiry` ON `idea_lab_import_jobs` (`owner_hash`,`expires_at`);