ALTER TABLE `knowledge_docs` MODIFY COLUMN `content` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` MODIFY COLUMN `final_text` mediumtext;