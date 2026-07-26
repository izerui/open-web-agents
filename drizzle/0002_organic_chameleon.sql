ALTER TABLE `runs` ADD `parent_run_id` varchar(36);--> statement-breakpoint
ALTER TABLE `runs` ADD `resume_anchor` varchar(128);--> statement-breakpoint
ALTER TABLE `runs` ADD `sdk_session_id` varchar(128);--> statement-breakpoint
CREATE INDEX `idx_runs_parent` ON `runs` (`parent_run_id`);