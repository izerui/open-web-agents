CREATE TABLE `knowledge_docs` (
	`id` varchar(36) NOT NULL,
	`assistant_id` varchar(36) NOT NULL,
	`title` varchar(255) NOT NULL,
	`content` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `knowledge_docs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_knowledge_assistant` ON `knowledge_docs` (`assistant_id`);