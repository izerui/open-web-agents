CREATE TABLE `agent_variables` (
	`agent_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`values_enc` varchar(4096) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	CONSTRAINT `agent_variables_agent_id_user_id_pk` PRIMARY KEY(`agent_id`,`user_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_agent_variables_user` ON `agent_variables` (`user_id`);