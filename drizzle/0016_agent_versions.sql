CREATE TABLE `agent_versions` (
	`agent_id` varchar(36) NOT NULL,
	`version` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`icon` varchar(64),
	`description` varchar(1024),
	`config` json NOT NULL,
	`content_hash` varchar(64) NOT NULL,
	`note` varchar(512),
	`created_by` varchar(36) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `uniq_agent_versions` UNIQUE(`agent_id`,`version`)
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `published_version` int;--> statement-breakpoint
ALTER TABLE `agents` ADD `published_hash` varchar(64);--> statement-breakpoint
ALTER TABLE `runs` ADD `agent_version` int;--> statement-breakpoint
ALTER TABLE `sessions` ADD `agent_version` int;