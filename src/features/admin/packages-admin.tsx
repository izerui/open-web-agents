"use client";

import { LoadError } from "@/components/load-error";
import { Badge } from "@/components/ui/badge";
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
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatPrice, parsePrice } from "@/features/billing/money";
import { creditsText } from "@/features/models/model-shared";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatTime } from "@/lib/format-time";
import type { CreditOrder, CreditPackage } from "@/lib/modules/billing/package-ports";
import { formatCredits, parseCredits } from "@/lib/modules/capabilities/domain/catalog";
import { cn } from "@/lib/utils";
import { Check, Pencil, Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AdminPage,
  AdminTabs,
  EmptyState,
  Segmented,
  TD,
  TH,
  TableCard,
  useTabParam,
} from "./admin-ui";

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
const STATUS: Record<Order["status"], string> = {
  pending: "待人工处理",
  credited: "积分已发放",
  cancelled: "已取消",
};
const STATUS_VARIANT = { pending: "warning", credited: "success", cancelled: "default" } as const;
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

const TABS = ["catalog", "orders"] as const;
type Tab = (typeof TABS)[number];
const ORDER_FILTERS = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待人工处理" },
  { value: "credited", label: "积分已发放" },
  { value: "cancelled", label: "已取消" },
] as const;
type OrderFilter = (typeof ORDER_FILTERS)[number]["value"];

const when = (ms: number) => formatTime(ms);

/** 价格只做展示：「¥ 100」后面跟币种小字 */
function Price({ minor, currency }: { minor: string; currency: "CNY" | "USD" }) {
  const [amount] = formatPrice(minor, currency).split(" ");
  const [whole = "0", cents = "00"] = (amount ?? "0").split(".");
  return (
    <span className="whitespace-nowrap">
      {currency === "CNY" ? "¥" : "$"} {Number(whole).toLocaleString()}
      {cents !== "00" ? `.${cents}` : ""}{" "}
      <span className="text-xs text-muted-foreground">{currency}</span>
    </span>
  );
}

/**
 * 平台管理 · 套餐与订单（原型 admin-packages.html）。
 * 业务逻辑搬自 PackageView 的管理分支：套餐每次保存生成新版本；订单人工确认后发放积分。
 */
export function PackagesAdmin() {
  const [tab, setTab] = useTabParam<Tab>(TABS, "catalog");
  const [packages, setPackages] = useState<CreditPackage[] | null>(null);
  const [orders, setOrders] = useState<OrderPage | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [ordersError, setOrdersError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<Order | null>(null);
  const [reason, setReason] = useState("");
  const [orderFilter, setOrderFilter] = useState<OrderFilter>("all");
  const catalogSeq = useRef(0);
  const orderSeq = useRef(0);
  const pending = useRef(false);

  const loadCatalog = useCallback(async () => {
    const seq = ++catalogSeq.current;
    setCatalogError("");
    try {
      const data = await fetchJson<{ packages: CreditPackage[] }>("/api/billing/packages?manage=1");
      if (seq === catalogSeq.current) setPackages(data.packages);
    } catch (err) {
      if (seq === catalogSeq.current) setCatalogError(errorText(err));
    }
  }, []);
  const loadOrders = useCallback(async (cursor?: string) => {
    const seq = ++orderSeq.current;
    setLoadingOrders(true);
    setOrdersError("");
    const query = new URLSearchParams({ manage: "1" });
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
  }, []);
  useEffect(() => {
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

  async function confirmOrder() {
    if (!confirming) return;
    await act(async () => {
      const result = await fetchJson<{ replayed?: boolean }>(
        `/api/billing/orders/${encodeURIComponent(confirming.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "confirm", reason: reason.trim() }),
        },
      );
      toast.success(result.replayed ? "原订单已发放，没有重复入账" : "积分已发放");
      setConfirming(null);
      setReason("");
      await loadOrders();
    });
  }

  const pendingCount = orders?.items.filter((o) => o.status === "pending").length ?? 0;
  const shownOrders =
    orders?.items.filter((o) => orderFilter === "all" || o.status === orderFilter) ?? [];

  return (
    <AdminPage
      title="套餐与订单"
      subtitle="固定积分包，长期有效。在线支付和自动扣费都没有启用，订单由管理员线下收款后人工确认。"
      tabs={
        <AdminTabs
          label="套餐与订单"
          value={tab}
          onChange={setTab}
          items={[
            { value: "catalog", label: "套餐目录" },
            {
              value: "orders",
              label: "订单",
              badge: pendingCount ? (
                <Badge variant="warning">
                  {pendingCount}
                  {orders?.nextCursor ? "+" : ""} 待处理
                </Badge>
              ) : undefined,
            },
          ]}
        />
      }
    >
      {tab === "catalog" ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">
              每次保存生成新版本；已有订单按下单时的版本结算，不受影响。
            </p>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadCatalog()}>
              <RefreshCw />
              刷新
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setDraft(fresh());
                setActionError("");
              }}
            >
              <Plus />
              添加套餐
            </Button>
          </div>
          <TableCard>
            {catalogError ? (
              <LoadError
                what="套餐目录"
                message={catalogError}
                onRetryAction={() => void loadCatalog()}
              />
            ) : packages === null ? (
              <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                正在加载…
              </div>
            ) : packages.length === 0 ? (
              <EmptyState title="还没有套餐">添加一个积分包，用户才能在账户里下单。</EmptyState>
            ) : (
              <table className="w-full min-w-[820px] border-collapse text-sm">
                <caption className="sr-only">积分套餐目录</caption>
                <thead>
                  <tr>
                    {["标识", "名称与说明", "积分数量", "价格", "版本", "上架"].map((h) => (
                      <th key={h} scope="col" className={TH}>
                        {h}
                      </th>
                    ))}
                    <th className={TH}>
                      <span className="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {packages.map((pack) => (
                    <tr key={pack.id}>
                      <td className={cn(TD, "font-mono text-[13px]")}>{pack.id}</td>
                      <td className={TD}>
                        <div className="font-semibold break-words">{pack.name}</div>
                        {pack.description && (
                          <div className="text-xs break-words text-muted-foreground">
                            {pack.description}
                          </div>
                        )}
                      </td>
                      <td className={cn(TD, "whitespace-nowrap")}>
                        {creditsText(pack.creditsMicro)}
                      </td>
                      <td className={TD}>
                        <Price minor={pack.priceMinor} currency={pack.currency} />
                      </td>
                      <td className={TD}>v{pack.version}</td>
                      <td className={TD}>
                        {pack.enabled ? (
                          <Badge variant="success">上架中</Badge>
                        ) : (
                          <Badge>未上架</Badge>
                        )}
                      </td>
                      <td className={cn(TD, "text-right")}>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => edit(pack)}
                        >
                          <Pencil className="size-3.5" />
                          编辑
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TableCard>
          <p className="mt-2.5 text-xs text-muted-foreground">
            用户在「账户」的积分与套餐里只能看到上架中的套餐。
            <Link
              href="/account/packages"
              className="ml-1 text-foreground underline underline-offset-2"
            >
              看用户视角
            </Link>
          </p>
        </>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Segmented
              label="按订单状态筛选"
              items={ORDER_FILTERS}
              value={orderFilter}
              onChange={setOrderFilter}
            />
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={busy || loadingOrders}
              onClick={() => void loadOrders()}
            >
              <RefreshCw className={cn(loadingOrders && "animate-spin")} />
              刷新
            </Button>
          </div>
          <TableCard>
            {ordersError ? (
              <LoadError
                what="订单"
                message={ordersError}
                onRetryAction={() => void loadOrders()}
              />
            ) : orders === null ? (
              <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                正在加载订单…
              </div>
            ) : shownOrders.length === 0 ? (
              <EmptyState
                title={orderFilter === "all" ? "暂无订单" : `没有「${STATUS[orderFilter]}」的订单`}
              >
                用户在「积分与套餐」里下单后会出现在这里。
              </EmptyState>
            ) : (
              <table className="w-full min-w-[880px] border-collapse text-sm">
                <caption className="sr-only">积分套餐订单</caption>
                <thead>
                  <tr>
                    {["订单号", "账号", "套餐", "积分", "金额", "状态", "时间"].map((h) => (
                      <th key={h} scope="col" className={TH}>
                        {h}
                      </th>
                    ))}
                    <th scope="col" className={cn(TH, "text-right")}>
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shownOrders.map((order) => (
                    <tr key={order.id}>
                      <td className={cn(TD, "max-w-48 font-mono text-xs break-all")}>{order.id}</td>
                      <td className={cn(TD, "max-w-56 break-all")}>
                        {order.accountEmail ?? order.accountId}
                      </td>
                      <td className={TD}>
                        {order.packageName}{" "}
                        <span className="text-xs text-muted-foreground">
                          v{order.packageVersion}
                        </span>
                      </td>
                      <td className={cn(TD, "whitespace-nowrap")}>
                        {creditsText(order.creditsMicro)}
                      </td>
                      <td className={TD}>
                        <Price minor={order.priceMinor} currency={order.currency} />
                      </td>
                      <td className={TD}>
                        <Badge variant={STATUS_VARIANT[order.status]}>{STATUS[order.status]}</Badge>
                        {order.confirmationReason && (
                          <div className="mt-1 max-w-56 text-xs break-words text-muted-foreground">
                            {order.confirmationReason}
                          </div>
                        )}
                      </td>
                      <td className={cn(TD, "text-xs whitespace-nowrap text-muted-foreground")}>
                        {when(order.createdAt)}
                      </td>
                      <td className={cn(TD, "text-right whitespace-nowrap")}>
                        {order.status === "pending" ? (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              setActionError("");
                              setReason("");
                              setConfirming(order);
                            }}
                          >
                            <Check className="size-3.5" />
                            人工确认
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TableCard>
          {orders?.nextCursor && (
            <div className="mt-3.5 text-center">
              <Button
                variant="outline"
                size="sm"
                disabled={loadingOrders}
                onClick={() => void loadOrders(orders.nextCursor)}
              >
                加载更早的订单
              </Button>
            </div>
          )}
        </>
      )}

      <Dialog open={draft !== null} onOpenChange={(open) => !open && !busy && setDraft(null)}>
        <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{draft?.version ? "编辑套餐" : "添加套餐"}</DialogTitle>
            <DialogDescription>
              {draft?.version
                ? `当前 v${draft.version},保存后生成 v${draft.version + 1}。已有订单按原版本，不受影响。`
                : "保存后生成 v1。"}
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
              <div className="min-h-0 overflow-y-auto px-0.5">
                <fieldset disabled={busy} className="grid gap-3.5">
                  <label
                    className="grid gap-1.5 text-[13px] text-muted-foreground"
                    htmlFor="pack-id"
                  >
                    <span>
                      标识 <span className="text-destructive">*</span>
                    </span>
                    <Input
                      id="pack-id"
                      required
                      maxLength={64}
                      className="font-mono"
                      disabled={draft.version !== null}
                      value={draft.id}
                      onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                    />
                  </label>
                  <label
                    className="grid gap-1.5 text-[13px] text-muted-foreground"
                    htmlFor="pack-name"
                  >
                    <span>
                      名称 <span className="text-destructive">*</span>
                    </span>
                    <Input
                      id="pack-name"
                      required
                      maxLength={120}
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                  </label>
                  <label
                    className="grid gap-1.5 text-[13px] text-muted-foreground"
                    htmlFor="pack-description"
                  >
                    说明
                    <Textarea
                      id="pack-description"
                      maxLength={1024}
                      value={draft.description}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label
                      className="grid gap-1.5 text-[13px] text-muted-foreground"
                      htmlFor="pack-credits"
                    >
                      <span>
                        积分数量 <span className="text-destructive">*</span>
                      </span>
                      <Input
                        id="pack-credits"
                        required
                        inputMode="decimal"
                        value={draft.credits}
                        onChange={(e) => setDraft({ ...draft, credits: e.target.value })}
                      />
                    </label>
                    <label
                      className="grid gap-1.5 text-[13px] text-muted-foreground"
                      htmlFor="pack-price"
                    >
                      <span>
                        价格 <span className="text-destructive">*</span>
                      </span>
                      <Input
                        id="pack-price"
                        required
                        inputMode="decimal"
                        value={draft.price}
                        onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                      />
                    </label>
                  </div>
                  <label
                    className="grid gap-1.5 text-[13px] text-muted-foreground"
                    htmlFor="pack-currency"
                  >
                    币种
                    <NativeSelect
                      id="pack-currency"
                      value={draft.currency}
                      onChange={(e) =>
                        setDraft({ ...draft, currency: e.target.value as Draft["currency"] })
                      }
                    >
                      <option value="CNY">CNY（人民币）</option>
                      <option value="USD">USD（美元）</option>
                    </NativeSelect>
                  </label>
                  <label
                    className="flex min-h-10 items-center gap-2.5 text-sm"
                    htmlFor="pack-enabled"
                  >
                    <Switch
                      id="pack-enabled"
                      checked={draft.enabled}
                      onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
                      className="data-[state=checked]:bg-success"
                    />
                    上架（用户可以看到并下单）
                  </label>
                </fieldset>
              </div>
              {actionError && (
                <p aria-live="assertive" className="text-sm text-destructive">
                  {actionError}
                </p>
              )}
              <DialogFooter className="shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setDraft(null)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "保存中…" : draft.version ? `保存为 v${draft.version + 1}` : "保存为 v1"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => !open && !busy && setConfirming(null)}
      >
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>人工确认并发放积分</DialogTitle>
            <DialogDescription>
              请先核对账号、订单和线下款项。这不是支付渠道的自动到账确认。
            </DialogDescription>
          </DialogHeader>
          {confirming && (
            <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl bg-band px-4 py-3 text-sm">
              <dt className="text-muted-foreground">订单</dt>
              <dd className="font-mono text-xs break-all">{confirming.id}</dd>
              <dt className="text-muted-foreground">账号</dt>
              <dd className="break-all">{confirming.accountEmail ?? confirming.accountId}</dd>
              <dt className="text-muted-foreground">套餐</dt>
              <dd>
                {confirming.packageName} v{confirming.packageVersion}
              </dd>
              <dt className="text-muted-foreground">积分</dt>
              <dd>{creditsText(confirming.creditsMicro)}</dd>
              <dt className="text-muted-foreground">金额</dt>
              <dd>
                <Price minor={confirming.priceMinor} currency={confirming.currency} />
              </dd>
            </dl>
          )}
          <label
            className="grid gap-1.5 text-[13px] text-muted-foreground"
            htmlFor="order-confirm-reason"
          >
            <span>
              人工确认说明 <span className="text-destructive">*</span>
            </span>
            <Textarea
              id="order-confirm-reason"
              maxLength={200}
              placeholder="例如：已核对 11 月 12 日对公转账"
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {actionError && (
            <p aria-live="assertive" className="text-sm text-destructive">
              {actionError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(null)}>
              返回
            </Button>
            <Button disabled={busy || !reason.trim()} onClick={() => void confirmOrder()}>
              {busy ? "处理中…" : "确认发放"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}
