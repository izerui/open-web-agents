-- 把 assistant 概念整体改名为 agent。
--
-- 【为什么是手写而不是 drizzle-kit generate】generate 遇到表/列重命名会弹交互式
-- prompt 问"这是新建还是改名",非 TTY 环境下静默挂死;即便在 TTY 下选对了,它还会
-- 因为主键条目名从 assistants_id 变成 agents_id 而多生成一对 DROP/ADD PRIMARY KEY,
-- 在 InnoDB 上那是整表重建。手写下来全程只有元数据改名,不搬一行数据。
--
-- 【为什么不用管主键约束】0000 里写的 `CONSTRAINT assistants_id PRIMARY KEY` 那个名字
-- 从来没落过库 —— InnoDB 忽略主键约束名,实际恒为 PRIMARY。只需在 snapshot 里改。
--
-- 【前置事实】全库无外键约束,改名不会有 FK 指向失效。
RENAME TABLE `assistants` TO `agents`;
--> statement-breakpoint
ALTER TABLE `agents` RENAME INDEX `idx_assistants_owner` TO `idx_agents_owner`;
--> statement-breakpoint
ALTER TABLE `sessions` RENAME COLUMN `assistant_id` TO `agent_id`;
--> statement-breakpoint
ALTER TABLE `sessions` RENAME INDEX `idx_sessions_assistant` TO `idx_sessions_agent`;
--> statement-breakpoint
ALTER TABLE `api_keys` RENAME COLUMN `assistant_id` TO `agent_id`;
--> statement-breakpoint
ALTER TABLE `knowledge_docs` RENAME COLUMN `assistant_id` TO `agent_id`;
--> statement-breakpoint
ALTER TABLE `knowledge_docs` RENAME INDEX `idx_knowledge_assistant` TO `idx_knowledge_agent`;
--> statement-breakpoint
-- 存量分享记录的 resource_type 存的是字符串 'assistant'(见 access/domain/grants.ts
-- 的 ResourceType)。不改这一条,所有已分享的智能体会在鉴权时匹配不上,等于全部失效。
UPDATE `access_grants` SET `resource_type` = 'agent' WHERE `resource_type` = 'assistant';
