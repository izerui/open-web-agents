DROP TABLE `user_valves`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `verify_rules`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `visibility`;--> statement-breakpoint
ALTER TABLE `api_keys` DROP COLUMN `quota`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `base_url`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `key_enc`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `model`;