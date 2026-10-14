CREATE INDEX `idx_runs_created` ON `runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_caller` ON `sessions` (`caller_api_key_id`);