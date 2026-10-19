-- 网页嵌入组件已下线。历史嵌入会话本就由 API Key 创建、计费归签发人,并入 api 来源。
UPDATE `sessions` SET `source` = 'api' WHERE `source` = 'embed';
