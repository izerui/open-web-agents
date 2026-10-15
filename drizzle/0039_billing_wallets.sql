CREATE TABLE `billing_ledger` (
	`id` varchar(36) NOT NULL,
	`account_key` varchar(64) NOT NULL,
	`account_id` varchar(36) NOT NULL,
	`operation_key` varchar(64) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`amount_micro_credits` decimal(30,0) NOT NULL,
	`available_after` decimal(30,0) NOT NULL,
	`reserved_after` decimal(30,0) NOT NULL,
	`reference` varchar(128) NOT NULL,
	`actor_id` varchar(36),
	`reason` varchar(512),
	`created_at` bigint NOT NULL,
	CONSTRAINT `billing_ledger_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_billing_ledger_operation` UNIQUE(`operation_key`)
);
--> statement-breakpoint
CREATE TABLE `billing_reservations` (
	`reservation_key` varchar(64) NOT NULL,
	`id` varchar(128) NOT NULL,
	`account_id` varchar(36) NOT NULL,
	`amount_micro_credits` decimal(30,0) NOT NULL,
	`state` varchar(16) NOT NULL,
	`charged_micro_credits` decimal(30,0),
	CONSTRAINT `billing_reservations_reservation_key` PRIMARY KEY(`reservation_key`)
);
--> statement-breakpoint
CREATE TABLE `billing_wallets` (
	`account_key` varchar(64) NOT NULL,
	`account_id` varchar(36) NOT NULL,
	`available_micro_credits` decimal(30,0) NOT NULL DEFAULT '0',
	`reserved_micro_credits` decimal(30,0) NOT NULL DEFAULT '0',
	CONSTRAINT `billing_wallets_account_key` PRIMARY KEY(`account_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_billing_ledger_account` ON `billing_ledger` (`account_key`,`created_at`,`id`);