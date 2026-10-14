CREATE TABLE `webhook_deliveries` (
	`id` varchar(36) NOT NULL,
	`agent_id` varchar(36) NOT NULL,
	`run_id` varchar(36),
	`trigger` varchar(16) NOT NULL,
	`attempt` int,
	`url` varchar(512) NOT NULL,
	`http_status` int,
	`ok` int NOT NULL,
	`error` varchar(512),
	`duration_ms` int NOT NULL,
	`signed` int NOT NULL,
	`at_ms` bigint NOT NULL,
	CONSTRAINT `webhook_deliveries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_agent` ON `webhook_deliveries` (`agent_id`,`at_ms`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_run` ON `webhook_deliveries` (`run_id`);