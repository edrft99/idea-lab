CREATE TABLE `idea_lab_semantic_vectors` (
	`owner_hash` text NOT NULL,
	`profile_hash` text NOT NULL,
	`idea_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`input_revision` text NOT NULL,
	`fields_json` text NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`vector` text NOT NULL,
	`vector_hash` text NOT NULL,
	`operation_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`owner_hash`, `profile_hash`, `idea_id`)
);
--> statement-breakpoint
CREATE INDEX `semantic_owner_operation` ON `idea_lab_semantic_vectors` (`owner_hash`,`operation_id`);--> statement-breakpoint
CREATE INDEX `semantic_owner_expiry` ON `idea_lab_semantic_vectors` (`owner_hash`,`expires_at`);