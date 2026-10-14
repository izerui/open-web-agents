CREATE TABLE `audit_logs` (
	`id` varchar(36) NOT NULL,
	`at_ms` bigint NOT NULL,
	`actor_type` varchar(16) NOT NULL,
	`actor_id` varchar(36),
	`actor_label` varchar(255),
	`action` varchar(64) NOT NULL,
	`resource_type` varchar(32) NOT NULL,
	`resource_id` varchar(64),
	`owner_id` varchar(36),
	`details` json,
	`ip` varchar(64),
	`user_agent` varchar(256),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_audit_owner` ON `audit_logs` (`owner_id`,`at_ms`);--> statement-breakpoint
CREATE INDEX `idx_audit_actor` ON `audit_logs` (`actor_id`,`at_ms`);--> statement-breakpoint
CREATE INDEX `idx_audit_resource` ON `audit_logs` (`resource_type`,`resource_id`,`at_ms`);--> statement-breakpoint
CREATE INDEX `idx_audit_time` ON `audit_logs` (`at_ms`);