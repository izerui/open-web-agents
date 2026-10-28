"use client";

import { SpaceShell } from "@/components/space-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { CreditOrder, CreditPackage } from "@/lib/modules/billing/package-ports";
import { formatCredits, parseCredits } from "@/lib/modules/capabilities/domain/catalog";
import { Check, Package, Pencil, Plus, RefreshCw, Save, ShoppingCart, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatPrice, parsePrice } from "./money";

type Order = CreditOrder & { accountEmail?: string };
type OrderPage = { items: Order[]; nextCursor?: string };
type Draft = {
  id: string;
  name: string;
  description: string;
  credits: string;
  price: string;
  currency: "CNY" | "USD";
  enabled: boolean;
  version: number | null;
};
const STATUS = { pending: "待人工处理", credited: "积分已发放", cancelled: "已取消" };
const fresh = (): Draft => ({
  id: "",
  name: "",
  description: "",
  credits: "",
  price: "",
  currency: "CNY",
  enabled: false,
  version: null,
});

export function PackageView({ admin = false }: { admin?: boolean }) {
  const [view, setView] = useState("catalog");
  const [packages, setPackages] = useState<CreditPackage[] | null>(null);
  const [orders, setOrders] = useState<OrderPage | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [ordersError, setOrdersError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [purchase, setPurchase] = useState<CreditPackage | null>(null);
  const [action, setAction] = useState<{ order: Order; kind: "confirm" | "cancel" } | null>(null);
  const [reason, setReason] = useState("");
  const catalogSeq = useRef(0);
  const orderSeq = useRef(0);
  const requestKey = useRef<{ intent: string; key: string } | null>(null);
  const pending = useRef(false);

  const loadCatalog = useCallback(async () => {
    const seq = ++catalogSeq.current;
    setCatalogError("");
    try {
      const data = await fetchJson<{
        packages: CreditPackage[];
      }>(`/api/billing/packages${admin ? "?manage=1" : ""}`);
      if (seq === catalogSeq.current) setPackages(data.packages);
    } catch (err) {
      if (seq === catalogSeq.current) setCatalogError(errorText(err));
    }
  }, [admin]);
  const loadOrders = useCallback(
    async (cursor?: string) => {
      const seq = ++orderSeq.current;
      setLoadingOrders(true);
      setOrdersError("");
      const query = new URLSearchParams();
      if (admin) query.set("manage", "1");
      if (cursor) query.set("cursor", cursor);
      try {
        const data = await fetchJson<OrderPage>(`/api/billing/orders?${query}`);
        if (seq === orderSeq.current)
          setOrders((prior) => ({
            ...data,
            items: cursor ? [...(prior?.items ?? []), ...data.items] : data.items,
          }));
      } catch (err) {
        if (seq === orderSeq.current) setOrdersError(errorText(err));
      } finally {
        if (seq === orderSeq.current) setLoadingOrders(false);
      }
    },
    [admin],
  );
  useEffect(() => {
    setPackages(null);
    setOrders(null);
    void loadCatalog();
    void loadOrders();
    return () => {
      catalogSeq.current++;
      orderSeq.current++;
    };
  }, [loadCatalog, loadOrders]);

  async function act(fn: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setActionError("");
    try {
      await fn();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function edit(pack: CreditPackage) {
    const cents = BigInt(pack.priceMinor);
    setActionError("");
    setDraft({
      id: pack.id,
      name: pack.name,
      description: pack.description ?? "",
      credits: formatCredits(pack.creditsMicro),
      price: `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`,
      currency: pack.currency,
      enabled: pack.enabled,
      version: pack.version,
    });
  }

  async function savePackage() {
    if (!draft) return;
    await act(async () => {
      await fetchJson("/api/billing/packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: draft.version,
          definition: {
            id: draft.id.trim(),
            name: draft.name.trim(),
            description: draft.description.trim(),
            creditsMicro: parseCredits(draft.credits.trim()),
            priceMinor: parsePrice(draft.price.trim()),
            currency: draft.currency,
            enabled: draft.enabled,
          },
        }),
      });
      setDraft(null);
      toast.success("套餐版本已保存");
      await loadCatalog();
    });
  }

  async function createOrder() {
    if (!purchase) return;
    await act(async () => {
      const intent = `${purchase.id}:${purchase.version}`;
      if (requestKey.current?.intent !== intent)
        requestKey.current = { intent, key: crypto.randomUUID() };
      const result = await fetchJson<{ order: Order; replayed: boolean }>("/api/billing/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey.current.key },
        body: JSON.stringify({ packageId: purchase.id, expectedVersion: purchase.version }),
      });
      requestKey.current = null;
      setPurchase(null);
      setView("orders");
      toast.success(result.replayed ? "已找到原订单,未重复创建" : "订单已创建,等待人工处理");
      await loadOrders();
    });
  }

  async function changeOrder() {
    if (!action) return;
    await act(async () => {
      const result = await fetchJson<{
        replayed?: boolean;
      }>(`/api/billing/orders/${encodeURIComponent(action.order.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: action.kind,
          ...(action.kind === "confirm" ? { reason: reason.trim() } : {}),
        }),
      });
      toast.success(
        action.kind === "cancel"
          ? "订单已取消"
          : result.replayed
            ? "原订单已发放,没有重复入账"
            : "积分已发放",
      );
      setAction(null);
      setReason("");
      await loadOrders();
    });
  }

  return (
    <SpaceShell
      area={admin ? "admin" : "personal"}
      title={admin ? "套餐与订单" : "充值与订单"}
      actions={
        admin ? (
          <Button
            onClick={() => {
              setView("catalog");
              setDraft(fresh());
              setActionError("");
            }}
          >
            <Plus className="size-4" />
            添加套餐
          </Button>
        ) : undefined
      }
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <p className="text-sm text-muted-foreground">
          固定积分包，积分长期有效。当前订单由管理员人工处理；在线支付与模型自动扣费尚未启用。
        </p>
        <Link href={admin ? "/admin/billing" : "/settings/billing"} className="text-sm underline">
          查看积分账户
        </Link>
      </div>
      <Tabs value={view} onValueChange={setView}>
        <TabsList aria-label={admin ? "套餐与订单管理" : "充值与订单"} className="mb-5">
          <TabsTrigger value="catalog">{admin ? "套餐目录" : "选择积分包"}</TabsTrigger>
          <TabsTrigger value="orders">{admin ? "订单管理" : "我的订单"}</TabsTrigger>
        </TabsList>
        <TabsContent value="catalog">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{admin ? "套餐目录" : "选择积分包"}</h2>
            <Button
              size="icon"
              variant="ghost"
              title="刷新套餐"
              aria-label="刷新套餐"
              disabled={busy}
              onClick={() => void loadCatalog()}
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>
          {catalogError ? (
            <p aria-live="polite" className="text-sm text-destructive">
              {catalogError}
            </p>
          ) : packages === null ? (
            <p className="text-sm text-muted-foreground">载入中…</p>
          ) : packages.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">暂无上架套餐</p>
          ) : (
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {packages.map((pack) => (
                <li key={pack.id} className="flex min-w-0 flex-col rounded-md border p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Package className="size-4 text-muted-foreground" />
                    <h3 className="min-w-0 break-words text-sm font-semibold">{pack.name}</h3>
                  </div>
                  <p className="break-all text-2xl font-medium">
                    {formatCredits(pack.creditsMicro)}{" "}
                    <span className="text-sm text-muted-foreground">积分</span>
                  </p>
                  <p className="mt-2 break-all font-mono text-lg">
                    {formatPrice(pack.priceMinor, pack.currency)}
                  </p>
                  {pack.description && (
                    <p className="mt-3 break-words text-sm text-muted-foreground">
                      {pack.description}
                    </p>
                  )}
                  <p className="my-3 text-xs text-muted-foreground">
                    v{pack.version} · 长期有效
                    {admin ? ` · ${pack.enabled ? "已上架" : "未上架"}` : ""}
                  </p>
                  <Button
                    className="mt-auto"
                    variant={admin ? "outline" : "default"}
                    disabled={busy}
                    onClick={() => {
                      setActionError("");
                      if (admin) edit(pack);
                      else setPurchase(pack);
                    }}
                  >
                    {admin ? <Pencil className="size-4" /> : <ShoppingCart className="size-4" />}
                    {admin ? "编辑套餐" : "创建订单"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
        <TabsContent value="orders">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">{admin ? "订单管理" : "我的订单"}</h2>
              <Button
                size="icon"
                variant="ghost"
                title="刷新订单"
                aria-label="刷新订单"
                disabled={busy || loadingOrders}
                onClick={() => void loadOrders()}
              >
                <RefreshCw className="size-4" />
              </Button>
            </div>
            {ordersError ? (
              <p aria-live="polite" className="text-sm text-destructive">
                {ordersError}
              </p>
            ) : orders === null ? (
              <p className="text-sm text-muted-foreground">载入中…</p>
            ) : orders.items.length === 0 ? (
              <p className="py-5 text-sm text-muted-foreground">暂无订单</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <caption className="sr-only">积分套餐订单</caption>
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      {[
                        "套餐 / 订单",
                        ...(admin ? ["账号"] : []),
                        "金额",
                        "积分",
                        "状态",
                        "操作",
                      ].map((title) => (
                        <th scope="col" key={title} className="px-2 py-3">
                          {title}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orders.items.map((order) => (
                      <tr key={order.id} className="border-b align-top">
                        <td className="max-w-64 px-2 py-3">
                          <p className="break-words font-medium">
                            {order.packageName} · v{order.packageVersion}
                          </p>
                          <p className="mt-1 break-all text-muted-foreground">{order.id}</p>
                          <p className="mt-1 whitespace-nowrap text-muted-foreground">
                            {new Date(order.createdAt).toLocaleString()}
                          </p>
                        </td>
                        {admin && (
                          <td className="max-w-48 break-all px-2 py-3">
                            {order.accountEmail ?? order.accountId}
                          </td>
                        )}
                        <td className="whitespace-nowrap px-2 py-3">
                          {formatPrice(order.priceMinor, order.currency)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-3 font-mono">
                          {formatCredits(order.creditsMicro)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-3">{STATUS[order.status]}</td>
                        <td className="px-2 py-3">
                          {order.status === "pending" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => {
                                setActionError("");
                                setReason("");
                                setAction({ order, kind: admin ? "confirm" : "cancel" });
                              }}
                            >
                              {admin ? <Check className="size-3" /> : <X className="size-3" />}
                              {admin ? "人工确认" : "取消订单"}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {orders?.nextCursor && (
              <Button
                variant="outline"
                className="mt-4"
                disabled={loadingOrders}
                onClick={() => void loadOrders(orders.nextCursor)}
              >
                加载更早订单
              </Button>
            )}
          </section>
        </TabsContent>
      </Tabs>
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDraft(null);
        }}
      >
        <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{draft?.version ? "编辑套餐" : "添加积分套餐"}</DialogTitle>
            <DialogDescription>
              保存生成新版本，已有订单继续使用创建时的价格和积分数量。
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form
              className="flex min-h-0 flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void savePackage();
              }}
            >
              {actionError && (
                <p aria-live="assertive" className="text-sm text-destructive">
                  {actionError}
                </p>
              )}
              <div className="min-h-0 overflow-y-auto pr-1">
                <fieldset disabled={busy} className="space-y-3">
                  <label className="block space-y-1 text-sm" htmlFor="pack-id">
                    <span>标识</span>
                    <Input
                      id="pack-id"
                      required
                      maxLength={64}
                      disabled={draft.version !== null}
                      value={draft.id}
                      onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                    />
                  </label>
                  <label className="block space-y-1 text-sm" htmlFor="pack-name">
                    <span>名称</span>
                    <Input
                      id="pack-name"
                      required
                      maxLength={120}
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                  </label>
                  <label className="block space-y-1 text-sm" htmlFor="pack-description">
                    <span>说明</span>
                    <Textarea
                      id="pack-description"
                      maxLength={1024}
                      value={draft.description}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          description: e.target.value,
                        })
                      }
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1 text-sm" htmlFor="pack-credits">
                      <span>积分数量</span>
                      <Input
                        id="pack-credits"
                        required
                        inputMode="decimal"
                        value={draft.credits}
                        onChange={(e) => setDraft({ ...draft, credits: e.target.value })}
                      />
                    </label>
                    <label className="space-y-1 text-sm" htmlFor="pack-price">
                      <span>价格</span>
                      <Input
                        id="pack-price"
                        required
                        inputMode="decimal"
                        value={draft.price}
                        onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                      />
                    </label>
                  </div>
                  <label className="block space-y-1 text-sm" htmlFor="pack-currency">
                    <span>币种</span>
                    <NativeSelect
                      id="pack-currency"
                      value={draft.currency}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          currency: e.target.value as Draft["currency"],
                        })
                      }
                    >
                      <option value="CNY">CNY · 人民币</option>
                      <option value="USD">USD · 美元</option>
                    </NativeSelect>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          enabled: e.target.checked,
                        })
                      }
                    />
                    上架套餐
                  </label>
                </fieldset>
              </div>
              <DialogFooter className="shrink-0 border-t pt-3">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDraft(null)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={busy}>
                  <Save className="size-4" />
                  保存版本
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={purchase !== null || action !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setPurchase(null);
            setAction(null);
          }
        }}
      >
        <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {purchase
                ? "确认创建订单"
                : action?.kind === "confirm"
                  ? "人工确认并发放积分"
                  : "取消套餐订单"}
            </DialogTitle>
            <DialogDescription>
              {purchase
                ? "创建订单不会扣款或立即发放积分。当前由管理员人工核对并处理。"
                : action?.kind === "confirm"
                  ? "请先核对账号、订单和线下款项。这不是支付渠道的自动到账确认。"
                  : "仅可取消尚未发放积分的订单。"}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-3 overflow-y-auto">
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-muted-foreground">套餐</dt>
                <dd>{purchase?.name ?? action?.order.packageName}</dd>
              </div>
              {action && (
                <div>
                  <dt className="text-muted-foreground">账号</dt>
                  <dd className="break-all">
                    {action.order.accountEmail ?? action.order.accountId}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-muted-foreground">积分</dt>
                <dd className="font-mono">
                  {formatCredits(purchase?.creditsMicro ?? action?.order.creditsMicro ?? "0")}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">金额</dt>
                <dd>
                  {formatPrice(
                    purchase?.priceMinor ?? action?.order.priceMinor ?? "0",
                    purchase?.currency ?? action?.order.currency ?? "CNY",
                  )}
                </dd>
              </div>
            </dl>
            {action?.kind === "confirm" && (
              <label className="block space-y-1 text-sm" htmlFor="order-confirm-reason">
                <span>人工确认说明</span>
                <Textarea
                  id="order-confirm-reason"
                  maxLength={200}
                  value={reason}
                  disabled={busy}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            )}
            {actionError && (
              <p aria-live="assertive" className="text-sm text-destructive">
                {actionError}
              </p>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPurchase(null);
                setAction(null);
              }}
            >
              返回
            </Button>
            <Button
              disabled={busy || (action?.kind === "confirm" && !reason.trim())}
              onClick={() => void (purchase ? createOrder() : changeOrder())}
            >
              {busy
                ? "处理中…"
                : purchase
                  ? "创建订单"
                  : action?.kind === "confirm"
                    ? "确认发放"
                    : "确认取消"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SpaceShell>
  );
}
