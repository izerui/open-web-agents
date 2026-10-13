ALTER TABLE `sessions` ADD `source` varchar(16) DEFAULT 'web' NOT NULL;--> statement-breakpoint
-- 回填来源:invoke 会话是无人值守的;embed 会话由嵌入令牌接口建,标题固定为 embed;其余带 key 的是 API 会话
UPDATE `sessions` SET `source` = 'invoke' WHERE `unattended` = 1;--> statement-breakpoint
UPDATE `sessions` SET `source` = 'embed' WHERE `unattended` = 0 AND `caller_api_key_id` IS NOT NULL AND `title` = 'embed';--> statement-breakpoint
UPDATE `sessions` SET `source` = 'api' WHERE `unattended` = 0 AND `caller_api_key_id` IS NOT NULL AND `source` = 'web';
