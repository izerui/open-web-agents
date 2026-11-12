CREATE TABLE `market_listing_requests` (
	`id` varchar(36) NOT NULL,
	`agent_id` varchar(36) NOT NULL,
	`version` int NOT NULL,
	`requester_id` varchar(36) NOT NULL,
	`note` varchar(1024),
	`status` varchar(16) NOT NULL,
	`reason` varchar(1024),
	`category` varchar(32),
	`pending_agent_id` varchar(36),
	`created_at` bigint NOT NULL,
	`decided_at` bigint,
	`decided_by` varchar(36),
	CONSTRAINT `market_listing_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_listing_requests_pending` UNIQUE(`pending_agent_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_listing_requests_agent` ON `market_listing_requests` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_listing_requests_status` ON `market_listing_requests` (`status`,`created_at`);