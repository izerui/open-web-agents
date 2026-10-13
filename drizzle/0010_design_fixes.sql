ALTER TABLE `runs` MODIFY COLUMN `prompt` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `agent_config` json;--> statement-breakpoint
ALTER TABLE `runs` ADD `override_enc` varchar(2048);--> statement-breakpoint
ALTER TABLE `runs` ADD `idempotency_key` varchar(191);--> statement-breakpoint
ALTER TABLE `runs` ADD `webhook_state` varchar(16);--> statement-breakpoint
ALTER TABLE `runs` ADD `webhook_attempts` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `webhook_next_at` bigint;--> statement-breakpoint
ALTER TABLE `sessions` ADD `billing_user_id` varchar(36);--> statement-breakpoint
ALTER TABLE `users` ADD `webhook_secret_enc` varchar(1024);--> statement-breakpoint
ALTER TABLE `runs` ADD CONSTRAINT `uniq_runs_idempotency` UNIQUE(`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_runs_webhook` ON `runs` (`webhook_state`,`webhook_next_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_billing` ON `sessions` (`billing_user_id`);--> statement-breakpoint
-- 回填计费归属:人用会话归 owner;API Key / embed 会话归签发该 key 的账号。
UPDATE `sessions` SET `billing_user_id` = `owner_id` WHERE `billing_user_id` IS NULL AND `owner_id` IS NOT NULL;--> statement-breakpoint
UPDATE `sessions` s JOIN `api_keys` k ON k.`id` = s.`caller_api_key_id` SET s.`billing_user_id` = k.`owner_id` WHERE s.`billing_user_id` IS NULL;
