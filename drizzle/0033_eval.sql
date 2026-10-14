CREATE TABLE `eval_cases` (
	`id` varchar(36) NOT NULL,
	`agent_id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`input` json NOT NULL,
	`assertions` json NOT NULL,
	`created_by` varchar(36),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `eval_cases_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `eval_results` (
	`eval_run_id` varchar(36) NOT NULL,
	`case_id` varchar(36) NOT NULL,
	`case_name` varchar(255) NOT NULL,
	`input` json NOT NULL,
	`assertions` json NOT NULL,
	`task_id` varchar(36),
	`session_id` varchar(36),
	`status` varchar(16) NOT NULL,
	`failures` json,
	`cost_micro_usd` bigint,
	`duration_ms` int,
	`graded_at` timestamp(3),
	CONSTRAINT `eval_results_eval_run_id_case_id_pk` PRIMARY KEY(`eval_run_id`,`case_id`)
);
--> statement-breakpoint
CREATE TABLE `eval_runs` (
	`id` varchar(36) NOT NULL,
	`agent_id` varchar(36) NOT NULL,
	`agent_version` int,
	`status` varchar(16) NOT NULL,
	`total` int NOT NULL,
	`passed` int NOT NULL DEFAULT 0,
	`failed` int NOT NULL DEFAULT 0,
	`started_by` varchar(36) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`finished_at` timestamp(3),
	CONSTRAINT `eval_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_eval_cases_agent` ON `eval_cases` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_eval_runs_agent` ON `eval_runs` (`agent_id`,`created_at`);