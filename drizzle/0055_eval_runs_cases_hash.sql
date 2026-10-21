ALTER TABLE `eval_runs` ADD `cases_hash` varchar(64);--> statement-breakpoint
CREATE INDEX `idx_eval_runs_config` ON `eval_runs` (`agent_id`,`config_hash`,`created_at`);