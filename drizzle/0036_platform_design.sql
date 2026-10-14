ALTER TABLE `sessions` ADD `design_state` json;
--> statement-breakpoint
UPDATE `sessions` SET `source` = 'design'
WHERE `agent_id` = 'agent-architect' AND `source` = 'web' AND `owner_id` IS NOT NULL;
--> statement-breakpoint
DELETE FROM `access_grants` WHERE `resource_type` = 'agent' AND `resource_id` = 'agent-architect';
