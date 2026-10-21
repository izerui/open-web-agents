import type { PublishGate } from "@/lib/modules/agent/application/releases";

/** 测试用:不检查评测、一律放行的发布门槛(只用在不测发布门槛的单测里) */
export const UNGATED: PublishGate = { blockReason: async () => null };
