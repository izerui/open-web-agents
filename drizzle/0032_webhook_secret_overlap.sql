ALTER TABLE `users` ADD `webhook_secret_prev_enc` varchar(1024);--> statement-breakpoint
ALTER TABLE `users` ADD `webhook_secret_prev_until` timestamp(3);