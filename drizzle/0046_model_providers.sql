CREATE TABLE `model_aliases` (
	`id` varchar(16) NOT NULL,
	`provider_id` varchar(64) NOT NULL,
	`fable` varchar(64) NOT NULL,
	`opus` varchar(64) NOT NULL,
	`sonnet` varchar(64) NOT NULL,
	`haiku` varchar(64) NOT NULL,
	`version` int NOT NULL,
	`updated_by` varchar(36) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	CONSTRAINT `model_aliases_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `model_providers` (
	`id` varchar(64) NOT NULL,
	`name` varchar(120) NOT NULL,
	`enabled` int NOT NULL DEFAULT 1,
	`api_key_enc` varchar(2048),
	`key_hint` varchar(32),
	`endpoints` json NOT NULL,
	`version` int NOT NULL,
	`updated_by` varchar(36) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL,
	CONSTRAINT `model_providers_id` PRIMARY KEY(`id`),
	CONSTRAINT `model_providers_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
ALTER TABLE `capability_catalog` ADD `provider_id` varchar(64);--> statement-breakpoint
CREATE INDEX `idx_capability_provider` ON `capability_catalog` (`provider_id`,`kind`);