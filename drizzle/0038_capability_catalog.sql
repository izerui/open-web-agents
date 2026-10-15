CREATE TABLE `capability_catalog` (
	`id` varchar(64) NOT NULL,
	`kind` varchar(24) NOT NULL,
	`model_id` varchar(200) NOT NULL,
	`enabled` int NOT NULL DEFAULT 0,
	`version` int NOT NULL,
	`definition` json NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	CONSTRAINT `capability_catalog_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `capability_versions` (
	`capability_id` varchar(64) NOT NULL,
	`version` int NOT NULL,
	`definition` json NOT NULL,
	`created_by` varchar(36) NOT NULL,
	`created_at` timestamp(3) NOT NULL,
	CONSTRAINT `capability_versions_capability_id_version_pk` PRIMARY KEY(`capability_id`,`version`)
);
