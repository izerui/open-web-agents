-- 试算已下线,计费恒为正式。试算留下的冻结只记在计费记录上、从没动过钱包,
-- 清零它们,不再占用账号与 Key 的月度额度;运行结束后清扫按旧记录规则结清(实扣 0)。
UPDATE `run_charges` SET `reserved_micro` = 0 WHERE `mode` = 'trial' AND `state` = 'open';
--> statement-breakpoint
DELETE FROM `platform_state` WHERE `k` = 'billing_mode';
