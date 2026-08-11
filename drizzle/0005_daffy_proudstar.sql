ALTER TABLE `users` ADD `disabled` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `monthly_quota_micro_usd` bigint;