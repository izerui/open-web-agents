/** 平台内部执行器,不参与业务智能体的授权、分享或发布。 */
export const DESIGN_EXECUTOR_ID = "agent-architect";

export function isSystemAgent(id: string): boolean {
  return id === DESIGN_EXECUTOR_ID;
}
