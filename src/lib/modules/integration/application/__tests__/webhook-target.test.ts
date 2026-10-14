// 所有者(owner)与调用方(caller,被分享后用自己的 Key 调用)是两个账号、各有各的签名密钥。
import {
  type RunTargetDeps,
  resolveRunTarget,
} from "@/lib/modules/integration/application/webhook-target";
import { describe, expect, it } from "vitest";

const A = "https://owner.example.com/hook-a";
const B = "https://owner.example.com/hook-b";

function deps(over: Partial<RunTargetDeps> = {}, source = "invoke"): RunTargetDeps {
  return {
    session: async () => ({ agentId: "a1", source, billingUserId: "caller" }),
    // 智能体【现在】的配置:地址已从 A 改成 B
    agentTarget: async (agentId) => ({ agentId, url: B, secret: "owner-s" }),
    ownerSecret: async () => "owner-s",
    userSecret: async (userId) => (userId === "caller" ? "caller-s" : undefined),
    ...over,
  };
}

describe("resolveRunTarget", () => {
  it("默认地址快照:受理时是 A,之后改成 B —— 仍投 A,仍用所有者的密钥(不是调用方的)", async () => {
    expect(
      await resolveRunTarget(deps(), { sessionId: "s1", callback: { source: "agent", url: A } }),
    ).toEqual({ agentId: "a1", url: A, secret: "owner-s" });
  });

  it("调用方指定的地址:用调用方的密钥签名;投递记录仍归属该智能体", async () => {
    expect(
      await resolveRunTarget(deps(), {
        sessionId: "s1",
        callback: { source: "caller", url: "https://caller.example.com/cb" },
      }),
    ).toEqual({ agentId: "a1", url: "https://caller.example.com/cb", secret: "caller-s" });
  });

  it("受理时没有回调:不投 —— 即便之后智能体配上了地址", async () => {
    expect(
      await resolveRunTarget(deps(), { sessionId: "s1", callback: { source: "none" } }),
    ).toBeNull();
  });

  it("没有快照的旧任务:按投递时的配置投", async () => {
    expect(await resolveRunTarget(deps(), { sessionId: "s1" })).toEqual({
      agentId: "a1",
      url: B,
      secret: "owner-s",
    });
  });

  it("调用方没配签名密钥:不签名,绝不借用所有者的密钥", async () => {
    const t = await resolveRunTarget(deps({ userSecret: async () => undefined }), {
      sessionId: "s1",
      callback: { source: "caller", url: "https://caller.example.com/cb" },
    });
    expect(t).toEqual({ agentId: "a1", url: "https://caller.example.com/cb" });
  });

  it("所有者没配签名密钥:默认地址不签名,也不借用调用方的", async () => {
    const t = await resolveRunTarget(deps({ ownerSecret: async () => undefined }), {
      sessionId: "s1",
      callback: { source: "agent", url: A },
    });
    expect(t).toEqual({ agentId: "a1", url: A });
  });

  it("密钥解不开:抛错(投递器据此判失败),不退化成不签名照发", async () => {
    const boom = async () => {
      throw new Error("无法解密");
    };
    await expect(
      resolveRunTarget(deps({ ownerSecret: boom }), {
        sessionId: "s1",
        callback: { source: "agent", url: A },
      }),
    ).rejects.toThrow(/无法解密/);
    await expect(
      resolveRunTarget(deps({ userSecret: boom }), {
        sessionId: "s1",
        callback: { source: "caller", url: "https://caller.example.com/cb" },
      }),
    ).rejects.toThrow(/无法解密/);
  });

  it("网页 / 嵌入会话不推回调,即便有快照", async () => {
    for (const source of ["web", "embed"]) {
      expect(
        await resolveRunTarget(deps({}, source), {
          sessionId: "s1",
          callback: { source: "agent", url: A },
        }),
      ).toBeNull();
    }
  });

  it("会话不存在:不投", async () => {
    expect(
      await resolveRunTarget(deps({ session: async () => null }), { sessionId: "s1" }),
    ).toBeNull();
  });
});
