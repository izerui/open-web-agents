-- 旧规则(不自动退款)留下的暂记:已扣多于应扣。清空它们的结算指纹,让清扫重新结算一次——
-- 费用能完整计价的,按自动退还规则退差额;还不能完整计价的不退,结算后重新写回指纹,不会每轮反复进入清扫。
UPDATE `run_charges`
SET `settled_cost_digest` = NULL
WHERE `state` = 'provisional'
  AND COALESCE(`charged_micro`, 0) > COALESCE(`estimated_micro`, 0);
