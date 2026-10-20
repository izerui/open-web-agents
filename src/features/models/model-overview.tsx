"use client";

import { SpaceShell } from "@/components/space-shell";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatMarkupPercent } from "@/lib/modules/capabilities/domain/pricing";
import Link from "next/link";
import { useEffect, useState } from "react";
import { type AdminModel, KIND_LABEL, KIND_ORDER, priceRows } from "./model-shared";

/** 只读:跨提供者对比模型与售价;编辑在所属提供者的详情页。 */
export function ModelOverview() {
  const [models, setModels] = useState<AdminModel[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetchJson<{ models: AdminModel[] }>("/api/admin/models").then(
      (r) => setModels(r.models),
      (err) => setError(errorText(err)),
    );
  }, []);

  return (
    <SpaceShell
      area="admin"
      title="模型总览"
      subtitle="所有提供者的模型与售价,点击名称到提供者页编辑"
    >
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!models ? (
        !error && <p className="text-sm text-muted-foreground">载入中…</p>
      ) : (
        <Tabs defaultValue="llm">
          <TabsList>
            {KIND_ORDER.map((k) => (
              <TabsTrigger key={k} value={k}>
                {KIND_LABEL[k]}
                <span className="ml-1 text-xs text-muted-foreground">
                  {models.filter((m) => m.kind === k).length}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          {KIND_ORDER.map((k) => {
            const list = models.filter((m) => m.kind === k);
            return (
              <TabsContent key={k} value={k} className="pt-2">
                {list.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    没有{KIND_LABEL[k]}模型
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">{KIND_LABEL[k]}模型总览</caption>
                      <thead>
                        <tr className="border-b text-xs text-muted-foreground">
                          {["模型", "提供者", "售价(积分)", "加价", "状态"].map((h) => (
                            <th key={h} scope="col" className="px-3 py-2">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((m) => (
                          <tr key={m.id} className="border-b align-top">
                            <td className="px-3 py-3">
                              <Link
                                href={`/admin/providers/${m.providerId}?tab=${m.kind}#model-${m.id}`}
                                className="font-medium underline-offset-4 hover:underline"
                              >
                                {m.name}
                              </Link>
                              <p className="mt-1 font-mono text-xs text-muted-foreground">
                                {m.modelId}
                              </p>
                            </td>
                            <td className="px-3 py-3">{m.providerName ?? "未归属"}</td>
                            <td className="px-3 py-3 text-xs leading-6 whitespace-nowrap">
                              {priceRows(m).map((r) => (
                                <p key={r.meter}>
                                  {r.label}:
                                  <span className="font-mono">{r.saleCredits ?? "—"}</span>
                                </p>
                              ))}
                            </td>
                            <td className="px-3 py-3">{formatMarkupPercent(m.markupBp ?? 0)}%</td>
                            <td className="px-3 py-3">
                              {m.enabled ? (
                                <Badge variant="secondary">启用</Badge>
                              ) : (
                                <Badge variant="outline">停用</Badge>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      )}
    </SpaceShell>
  );
}
