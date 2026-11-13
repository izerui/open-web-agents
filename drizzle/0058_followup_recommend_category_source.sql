ALTER TABLE `credit_packages` ADD `recommended` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `eval_cases` ADD `source` varchar(16) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `market_listing_requests` ADD `requested_category` varchar(32);