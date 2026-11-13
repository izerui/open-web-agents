import { describe, expect, it } from "vitest";
import {
  type ListingRequest,
  fetchListingRequest,
  listingView,
  submitListingRequest,
} from "../listing-request";

const req = (patch: Partial<ListingRequest> = {}): ListingRequest => ({
  id: "q1",
  status: "pending",
  version: 3,
  note: null,
  reason: null,
  category: null,
  createdAt: 1,
  decidedAt: null,
  ...patch,
});

const respond = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("上架申请接口封装(A13)", () => {
  it("读取:有记录、没有记录、接口不存在(404)", async () => {
    expect(await fetchListingRequest("a", respond(200, { request: req() }))).toEqual({
      kind: "ok",
      request: req(),
    });
    expect(await fetchListingRequest("a", respond(200, { request: null }))).toEqual({
      kind: "ok",
      request: null,
    });
    expect(await fetchListingRequest("a", respond(404, { error: "not found" }))).toEqual({
      kind: "unavailable",
    });
    expect(await fetchListingRequest("a", respond(500, {}))).toMatchObject({ kind: "error" });
  });

  it("提交:成功与各错误码", async () => {
    expect(
      await submitListingRequest("a", { note: "备注" }, respond(201, { request: req() })),
    ).toEqual({
      ok: true,
      request: req(),
    });
    expect(
      await submitListingRequest("a", {}, respond(409, { code: "pending_exists", error: "x" })),
    ).toEqual({ ok: false, message: "已有一条待审核的申请，请等管理员处理" });
    expect(
      await submitListingRequest("a", {}, respond(409, { code: "not_published", error: "x" })),
    ).toEqual({ ok: false, message: "需要先发布才能申请上架" });
    expect(
      await submitListingRequest("a", {}, respond(409, { code: "already_listed", error: "x" })),
    ).toEqual({ ok: false, message: "已在市场上架" });
    expect(await submitListingRequest("a", {}, respond(404, {}))).toEqual({
      ok: false,
      message: "上架申请暂不可用",
    });
  });
});

describe("申请时带上类别", () => {
  it("请求体带去掉空白的说明与类别;都没有时是空对象", async () => {
    const bodies: unknown[] = [];
    const capture = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ request: req() }), { status: 201 });
    };
    await submitListingRequest("a", { note: "  给财务用 ", category: "research" }, capture);
    await submitListingRequest("a", { note: "  " }, capture);
    expect(bodies).toEqual([{ note: "给财务用", category: "research" }, {}]);
  });
  it("服务端的无效类别有中文提示", async () => {
    expect(
      await submitListingRequest(
        "a",
        { category: "x" },
        respond(400, { code: "invalid_category", error: "x" }),
      ),
    ).toEqual({ ok: false, message: "请选择有效的类别" });
  });
});

describe("listingView:申请状态与按钮", () => {
  const base = { publishedVersion: 3, listed: false };
  it.each([
    [{ state: { kind: "unavailable" } }, "上架申请暂不可用", false, "提交申请"],
    [{ state: { kind: "loading" } }, "正在读取申请状态…", false, "提交申请"],
    [{ state: { kind: "ok", request: null }, listed: true }, "已在市场上架", false, "已上架"],
    [
      { state: { kind: "ok", request: null }, publishedVersion: null },
      "需要先发布才能申请上架",
      false,
      "提交申请",
    ],
    [
      { state: { kind: "ok", request: null } },
      "上架由管理员在「平台管理，市场上架」审核；需要先发布",
      true,
      "提交申请",
    ],
    [{ state: { kind: "ok", request: req() } }, "已提交 v3 的申请，等待审核", false, "等待审核"],
    [
      { state: { kind: "ok", request: req({ requestedCategory: "research" }) } },
      "已提交 v3 的申请（类别：研究分析），等待审核",
      false,
      "等待审核",
    ],
    [
      { state: { kind: "ok", request: req({ status: "rejected", reason: "说明太简单" }) } },
      "上次申请被驳回：说明太简单",
      true,
      "重新申请",
    ],
    [
      { state: { kind: "ok", request: req({ status: "approved" }) } },
      "v3 的申请已通过，但目前不在市场上",
      true,
      "重新申请",
    ],
  ])("%j", (patch, text, canSubmit, button) => {
    const v = listingView({ ...base, ...(patch as object) } as Parameters<typeof listingView>[0]);
    expect(v.text).toBe(text);
    expect(v.canSubmit).toBe(canSubmit);
    expect(v.button).toBe(button);
  });
});
