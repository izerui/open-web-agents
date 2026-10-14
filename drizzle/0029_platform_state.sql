CREATE TABLE `platform_state` (
	`k` varchar(64) NOT NULL,
	`v` varchar(255) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `platform_state_k` PRIMARY KEY(`k`)
);
--> statement-breakpoint
-- 已有用户的部署:第一个管理员早已产生,名额记为已占用 —— 否则下一个注册的人会成为管理员
INSERT IGNORE INTO `platform_state` (`k`, `v`) SELECT 'first_admin', `id` FROM `users` ORDER BY `created_at` ASC LIMIT 1;
