CREATE TABLE `run_charges` (
	`run_id` varchar(36) NOT NULL,
	`account_id` varchar(36) NOT NULL,
	`api_key_id` varchar(36),
	`mode` varchar(8) NOT NULL,
	`reserved_micro` decimal(30,0) NOT NULL,
	`reservation_ids` json NOT NULL,
	`estimated_micro` decimal(30,0),
	`charged_micro` decimal(30,0),
	`owed_micro` decimal(30,0),
	`state` varchar(8) NOT NULL,
	`would_reject` varchar(32),
	`incomplete` int NOT NULL DEFAULT 0,
	`created_at` timestamp(3) NOT NULL,
	`settled_at` timestamp(3),
	CONSTRAINT `run_charges_run_id` PRIMARY KEY(`run_id`)
);
--> statement-breakpoint
ALTER TABLE `api_keys` ADD `monthly_limit_micro_credits` decimal(30,0);--> statement-breakpoint
ALTER TABLE `runs` ADD `pricing` json;--> statement-breakpoint
ALTER TABLE `users` ADD `monthly_limit_micro_credits` decimal(30,0);--> statement-breakpoint
CREATE INDEX `idx_run_charges_account` ON `run_charges` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_run_charges_key` ON `run_charges` (`api_key_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_run_charges_state` ON `run_charges` (`state`,`created_at`);