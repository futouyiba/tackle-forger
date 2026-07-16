CREATE TABLE `imported_files` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`r2_key` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision` integer NOT NULL,
	`state_json` text NOT NULL,
	`author` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_revisions_revision_unique` ON `workspace_revisions` (`revision`);--> statement-breakpoint
CREATE TABLE `workspace_state` (
	`id` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL
);
