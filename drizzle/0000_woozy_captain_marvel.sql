CREATE TABLE `access_grants` (
	`id` varchar(36) NOT NULL,
	`resource_type` varchar(32) NOT NULL,
	`resource_id` varchar(36) NOT NULL,
	`principal_type` varchar(16) NOT NULL,
	`principal_id` varchar(36) NOT NULL,
	`permission` varchar(16) NOT NULL,
	CONSTRAINT `access_grants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` varchar(36) NOT NULL,
	`assistant_id` varchar(36),
	`owner_id` varchar(36) NOT NULL,
	`hashed_key` varchar(128) NOT NULL,
	`name` varchar(255),
	`quota` json,
	`last_used_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_keys_hashed_key_unique` UNIQUE(`hashed_key`)
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` varchar(36) NOT NULL,
	`session_id` varchar(36) NOT NULL,
	`path` varchar(1024) NOT NULL,
	`mime` varchar(128),
	`size` bigint,
	`storage_url` varchar(1024),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `artifacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `assistants` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`icon` varchar(64),
	`description` varchar(1024),
	`config` json NOT NULL,
	`input_schema` json,
	`output_schema` json,
	`verify_rules` json,
	`webhook_url` varchar(1024),
	`visibility` varchar(16) NOT NULL DEFAULT 'private',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `assistants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` varchar(36) NOT NULL,
	`session_id` varchar(36) NOT NULL,
	`role` varchar(16) NOT NULL,
	`content` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` varchar(36) NOT NULL,
	`session_id` varchar(36) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`prompt` varchar(8192) NOT NULL DEFAULT '',
	`lease_until` bigint,
	`attempts` int NOT NULL DEFAULT 0,
	`structured_result` json,
	`cost` json,
	`error_info` json,
	`started_at` timestamp,
	`ended_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` varchar(36) NOT NULL,
	`assistant_id` varchar(36) NOT NULL,
	`owner_id` varchar(36),
	`caller_api_key_id` varchar(36),
	`workspace_dir` varchar(512) NOT NULL,
	`sdk_session_id` varchar(128),
	`title` varchar(255),
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`base_url` varchar(512),
	`key_enc` varchar(1024),
	`model` varchar(32),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_valves` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`tool_id` varchar(128) NOT NULL,
	`config` json NOT NULL,
	CONSTRAINT `user_valves_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(36) NOT NULL,
	`email` varchar(255) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`role` varchar(16) NOT NULL DEFAULT 'user',
	`default_base_url` varchar(512),
	`anthropic_key_enc` varchar(1024),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE INDEX `idx_grants_resource` ON `access_grants` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_owner` ON `api_keys` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_session` ON `artifacts` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_assistants_owner` ON `assistants` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_session` ON `messages` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_runs_claim` ON `runs` (`status`,`lease_until`);--> statement-breakpoint
CREATE INDEX `idx_runs_session` ON `runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_assistant` ON `sessions` (`assistant_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_owner` ON `sessions` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_valves_user` ON `user_valves` (`user_id`);