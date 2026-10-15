ALTER TABLE `agents` ADD `market_listed` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `market_category` varchar(32);--> statement-breakpoint
CREATE INDEX `idx_agents_market` ON `agents` (`market_listed`,`published_version`);