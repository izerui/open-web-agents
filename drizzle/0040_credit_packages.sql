CREATE TABLE `credit_orders` (
	`id` varchar(36) NOT NULL,
	`account_key` varchar(64) NOT NULL,
	`account_id` varchar(36) NOT NULL,
	`operation_key` varchar(64) NOT NULL,
	`package_id` varchar(64) NOT NULL,
	`package_version` int NOT NULL,
	`package_name` varchar(120) NOT NULL,
	`credits_micro` decimal(30,0) NOT NULL,
	`price_minor` decimal(18,0) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`status` varchar(16) NOT NULL,
	`created_at` bigint NOT NULL,
	`credited_at` bigint,
	`credited_by` varchar(36),
	`ledger_id` varchar(36),
	`confirmation_reason` varchar(512),
	CONSTRAINT `credit_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_credit_orders_operation` UNIQUE(`operation_key`)
);
--> statement-breakpoint
CREATE TABLE `credit_package_versions` (
	`package_id` varchar(64) NOT NULL,
	`version` int NOT NULL,
	`definition` json NOT NULL,
	`created_by` varchar(36) NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `credit_package_versions_package_id_version_pk` PRIMARY KEY(`package_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `credit_packages` (
	`id` varchar(64) NOT NULL,
	`definition` json NOT NULL,
	`enabled` int NOT NULL,
	`version` int NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `credit_packages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_credit_orders_account` ON `credit_orders` (`account_key`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_credit_orders_time` ON `credit_orders` (`created_at`,`id`);