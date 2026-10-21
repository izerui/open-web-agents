"use client";

import { Button } from "@/components/ui/button";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { McpCheckResult } from "@/lib/modules/agent/domain/mcp-check";
import { CheckCircle2, Loader2, PlugZap, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const TRANSPORT_LABEL = {
  streamable_http: "Streamable HTTP",
  sse: "SSE(旧版)",
  stdio: "stdio",
} as const;

/**
 * MCP 的"测试连接":握手并列出工具,不调用工具。
 * requestAction 返回要 POST 的地址与请求体;配置还填不完整时抛错,直接显示给用户。
 * resetKey 变化(配置改了)时清掉上一次的结果,免得旧结果看着像新配置的
 */
export function McpCheck({
  requestAction,
  resetKey,
  name,
  disabledReason,
}: {
  requestAction: () => { url: string; body: unknown };
  resetKey: string;
  name: string;
  /** 不能测试的原因(如 AI 编辑里草稿还没保存);给了就禁用按钮并显示它 */
  disabledReason?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<McpCheckResult | null>(null);
  const [error, setError] = useState("");
  const seq = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在配置变化时清结果
  useEffect(() => {
    seq.current++;
    setResult(null);
    setError("");
    setBusy(false);
  }, [resetKey]);

  async function run() {
    const mine = ++seq.current;
    setBusy(true);
    setResult(null);
    setError("");
    try {
      const { url, body } = requestAction();
      const r = await fetchJson<{ result: McpCheckResult }>(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (mine === seq.current) setResult(r.result);
    } catch (err) {
      if (mine === seq.current) setError(errorText(err));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="mcp-check">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy || Boolean(disabledReason)}
        title={disabledReason}
        onClick={() => void run()}
        aria-label={`测试连接 ${name}`}
      >
        {busy ? <Loader2 className="animate-spin" /> : <PlugZap />}
        {busy ? "测试中…" : "测试连接"}
      </Button>
      {disabledReason && <p className="text-xs text-muted-foreground">{disabledReason}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {result?.ok === false && (
        <p
          className="flex items-start gap-1.5 text-xs text-destructive"
          data-testid="mcp-check-failed"
        >
          <XCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{result.message}</span>
        </p>
      )}
      {result?.ok && (
        <div className="rounded-md border p-2 text-xs" data-testid="mcp-check-ok">
          <p className="flex flex-wrap items-center gap-1.5">
            <CheckCircle2 className="size-3.5 text-emerald-600" />
            <span>
              连接成功{result.server.name ? `:${result.server.name}` : ""}
              {result.server.version ? ` ${result.server.version}` : ""}
            </span>
            <span className="text-muted-foreground">
              · {TRANSPORT_LABEL[result.transport]} · {result.latencyMs} ms · {result.tools.length}{" "}
              个工具(未调用)
            </span>
          </p>
          {result.tools.length > 0 && (
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {result.tools.map((t) => (
                <li key={t.name} className="break-words">
                  <code className="font-mono">{t.name}</code>
                  {t.description && (
                    <span className="text-muted-foreground"> — {t.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
