// 设计器附件:上传进设计会话的工作区(与对话页同一套限制),只能往自己的设计会话传。

import { DesignError } from "@/lib/modules/agent/application/designer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  denied: false,
  /** 设计会话归属:me 的会话才放行 */
  owner: "me",
  writes: [] as { dir: string; name: string; size: number; overwrite?: boolean }[],
  prepared: 0,
  existing: new Set<string>(),
}));

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => {
        if (state.denied) {
          const { Unauthorized } = await import("@/lib/modules/access/application/authorize");
          throw new Unauthorized("请先登录");
        }
        return { type: "web", userId: "me", role: "user" };
      },
      assertCanManageAgents: () => {},
      subjectOf: async () => ({ userId: "me", role: "user" }),
    },
    designer: {
      workspaceOf: async (subject: { userId: string }, id: string) => {
        if (subject.userId !== state.owner)
          throw new DesignError(404, "not_found", "设计会话不存在");
        return { sessionId: id, workspaceDir: "/data/ws/design-1" };
      },
    },
    sessions: {
      prepareWorkspace: async (_id: string, _opts: unknown, fn: () => Promise<void>) => {
        state.prepared++;
        await fn();
      },
    },
    storage: {
      write: async (dir: string, name: string, bytes: Buffer, opts?: { overwrite?: boolean }) => {
        if (state.existing.has(name) && !opts?.overwrite)
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        state.writes.push({ dir, name, size: bytes.length, overwrite: opts?.overwrite });
      },
    },
  }),
}));

vi.mock("node:fs/promises", () => ({ default: { mkdir: async () => undefined } }));

beforeEach(() => {
  state.denied = false;
  state.owner = "me";
  state.writes = [];
  state.prepared = 0;
  state.existing = new Set();
});

async function upload(files: File[], query = "") {
  const { POST } = await import("../route");
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await POST(
    new Request(`http://x/api/agents/design/d1/files${query}`, { method: "POST", body: form }),
    { params: Promise.resolve({ id: "d1" }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);

describe("POST /api/agents/design/[id]/files", () => {
  it("上传到自己设计会话的工作区,返回文件名", async () => {
    const r = await upload([file("报销制度.pdf"), file("规则.md")]);
    expect(r.status).toBe(200);
    expect(r.body.files).toEqual(["报销制度.pdf", "规则.md"]);
    expect(state.writes.map((w) => [w.dir, w.name])).toEqual([
      ["/data/ws/design-1", "报销制度.pdf"],
      ["/data/ws/design-1", "规则.md"],
    ]);
    expect(state.prepared).toBe(1);
  });

  it("别人的设计会话 404,什么都不写", async () => {
    state.owner = "someone-else";
    const r = await upload([file("a.md")]);
    expect(r.status).toBe(404);
    expect(state.writes).toHaveLength(0);
  });

  it("未登录 401", async () => {
    state.denied = true;
    expect((await upload([file("a.md")])).status).toBe(401);
    expect(state.writes).toHaveLength(0);
  });

  it("设计草稿文件名保留给设计器,不能被附件覆盖", async () => {
    const r = await upload([file("design-draft.json")], "?overwrite=1");
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toContain("design-draft.json");
    expect(state.writes).toHaveLength(0);
  });

  it("不支持覆盖:同名文件已存在 409", async () => {
    state.existing.add("a.md");
    const r = await upload([file("a.md")], "?overwrite=1");
    expect(r.status).toBe(409);
  });

  it("限制与对话页一致:单个 10MB、一次 20 个、不能越界、不能重名", async () => {
    expect((await upload([file("big.bin", 10 * 1024 * 1024 + 1)])).status).toBe(413);
    expect((await upload(Array.from({ length: 21 }, (_, i) => file(`f${i}.txt`)))).status).toBe(
      413,
    );
    expect((await upload([file("../escape.md")])).status).toBe(400);
    expect((await upload([file("a.md"), file("a.md")])).status).toBe(409);
    expect((await upload([])).status).toBe(400);
    expect(state.writes).toHaveLength(0);
  });
});
