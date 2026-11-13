// 申请上架市场(gaps A13,所有者端)。接口由平台管理(阶段 7)提供:
//   GET  /api/agents/[id]/listing-request → { request: ListingRequest | null }
//   POST /api/agents/[id]/listing-request  body { note?, category? } → 201 { request };
//        400 invalid_category;409 not_published / pending_exists / already_listed
// 调用集中在这里;接口不存在(404)时页面显示「上架申请暂不可用」而不是报错。

import { MARKET_CATEGORIES } from "@/lib/modules/market/domain/catalog";

export interface ListingRequest {
  id: string;
  status: "pending" | "approved" | "rejected";
  version: number;
  note?: string | null;
  reason?: string | null;
  /** 申请时选的类别 */
  requestedCategory?: string | null;
  /** 通过时上架到的类别 */
  category?: string | null;
  createdAt: number;
  decidedAt?: number | null;
}

export type ListingState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }
  | { kind: "ok"; request: ListingRequest | null };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const url = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/listing-request`;

export async function fetchListingRequest(
  agentId: string,
  fetcher: Fetcher = fetch,
): Promise<ListingState> {
  try {
    const res = await fetcher(url(agentId), { cache: "no-store" });
    if (res.status === 404) return { kind: "unavailable" };
    if (!res.ok) return { kind: "error", message: `HTTP ${res.status}` };
    const data = (await res.json()) as { request?: ListingRequest | null };
    return { kind: "ok", request: data.request ?? null };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

const SUBMIT_ERRORS: Record<string, string> = {
  not_published: "需要先发布才能申请上架",
  pending_exists: "已有一条待审核的申请，请等管理员处理",
  already_listed: "已在市场上架",
  invalid_category: "请选择有效的类别",
};

export async function submitListingRequest(
  agentId: string,
  input: { note?: string; category?: string },
  fetcher: Fetcher = fetch,
): Promise<{ ok: true; request: ListingRequest } | { ok: false; message: string }> {
  const note = input.note?.trim();
  const res = await fetcher(url(agentId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(note ? { note } : {}),
      ...(input.category ? { category: input.category } : {}),
    }),
  });
  if (res.status === 404) return { ok: false, message: "上架申请暂不可用" };
  const data = (await res.json().catch(() => ({}))) as {
    request?: ListingRequest;
    code?: string;
    error?: string;
  };
  if (res.ok && data.request) return { ok: true, request: data.request };
  return {
    ok: false,
    message: (data.code && SUBMIT_ERRORS[data.code]) || data.error || `HTTP ${res.status}`,
  };
}

/** 发布阶段「申请上架市场」一行的状态文案与按钮 */
export function listingView(i: {
  state: ListingState;
  publishedVersion: number | null;
  /** 当前已上架市场 */
  listed: boolean;
}): { text: string; tone: "" | "ok" | "warn" | "bad"; canSubmit: boolean; button: string } {
  const s = i.state;
  if (s.kind === "unavailable")
    return { text: "上架申请暂不可用", tone: "", canSubmit: false, button: "提交申请" };
  if (s.kind === "loading")
    return { text: "正在读取申请状态…", tone: "", canSubmit: false, button: "提交申请" };
  if (s.kind === "error")
    return {
      text: `申请状态读取失败：${s.message}`,
      tone: "bad",
      canSubmit: false,
      button: "提交申请",
    };
  if (i.listed) return { text: "已在市场上架", tone: "ok", canSubmit: false, button: "已上架" };
  if (i.publishedVersion === null)
    return { text: "需要先发布才能申请上架", tone: "", canSubmit: false, button: "提交申请" };
  const r = s.request;
  if (!r)
    return {
      text: "上架由管理员在「平台管理，市场上架」审核；需要先发布",
      tone: "",
      canSubmit: true,
      button: "提交申请",
    };
  if (r.status === "pending") {
    const cat = MARKET_CATEGORIES.find((c) => c.id === r.requestedCategory)?.name;
    return {
      text: `已提交 v${r.version} 的申请${cat ? `（类别：${cat}）` : ""}，等待审核`,
      tone: "warn",
      canSubmit: false,
      button: "等待审核",
    };
  }
  if (r.status === "rejected")
    return {
      text: `上次申请被驳回：${r.reason || "管理员没有写原因"}`,
      tone: "bad",
      canSubmit: true,
      button: "重新申请",
    };
  return {
    text: `v${r.version} 的申请已通过，但目前不在市场上`,
    tone: "",
    canSubmit: true,
    button: "重新申请",
  };
}
