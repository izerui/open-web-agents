"use client";

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
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { VariableDef } from "@/lib/modules/agent/domain/config";
import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { missingRequired, variableUpdates } from "./workbench.logic";

interface VariableState {
  variables: VariableDef[];
  values: Record<string, string>;
  filled: boolean;
}

/** 「变量已填写:A（已隐藏）、B = 值」——密钥只说填了,不露值 */
function filledSummary(state: VariableState): string {
  const parts = state.variables
    .filter((v) => state.values[v.name]?.trim())
    .map((v) => (v.secret ? `${v.name}（已隐藏）` : `${v.name} = ${state.values[v.name]}`));
  return parts.length ? `变量已填写：${parts.join("、")}` : "";
}

export function VariablePrompt({
  agentId,
  sessionId,
  onReady,
  onMissingChangeAction,
  openSignal = 0,
}: {
  agentId: string;
  sessionId?: string | null;
  onReady?: () => void;
  /** 还没填的必填变量(页面据此在发送前拦下);读不到变量定义时按没有缺失处理 */
  onMissingChangeAction?: (missing: string[]) => void;
  /** 变化时打开「填写变量」弹窗(发送被拦下时) */
  openSignal?: number;
}) {
  const [state, setState] = useState<VariableState | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (sessionId) params.set("sessionId", sessionId);
      const qs = params.toString();
      const data = await fetchJson<VariableState>(
        `/api/agents/${encodeURIComponent(agentId)}/variables${qs ? `?${qs}` : ""}`,
      );
      setState(data);
      if (data.variables.length > 0) {
        // 已保存的密钥不回显:输入框留空,占位写「已保存，留空不修改」
        setDraft(
          Object.fromEntries(
            data.variables.map((v) => [v.name, v.secret ? "" : (data.values[v.name] ?? "")]),
          ),
        );
      }
    } catch {}
  }, [agentId, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const missingNames = state ? missingRequired(state.variables, state.values) : [];
  const missingKey = missingNames.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在缺失集合变化时通知
  useEffect(() => {
    onMissingChangeAction?.(missingKey ? missingKey.split("\n") : []);
  }, [missingKey]);
  // 卸载(换智能体、换会话)时清掉,别让上一个智能体的缺失拦住下一个
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在卸载时执行
  useEffect(() => () => onMissingChangeAction?.([]), []);

  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);

  if (!state || state.variables.length === 0) return null;

  const missing = state.variables.filter((v) => missingNames.includes(v.name));

  async function save() {
    setBusy(true);
    setError("");
    try {
      await fetchJson(`/api/agents/${encodeURIComponent(agentId)}/variables`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(variableUpdates(state?.variables ?? [], state?.values ?? {}, draft)),
      });
      toast.success("变量已保存");
      setOpen(false);
      await load();
      onReady?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {missing.length > 0 ? (
        <div className="mx-5 mt-2.5 flex items-center gap-2 rounded-[10px] bg-warning-soft px-3 py-2 text-sm text-warning-text max-md:mx-3">
          <KeyRound className="size-[15px] shrink-0" />
          <span className="min-w-0 flex-1">
            需要填写 {missing.length} 个必填变量才能运行此智能体
          </span>
          <button
            type="button"
            className="shrink-0 underline decoration-[#C9C4B8] underline-offset-[3px] max-md:min-h-11"
            onClick={() => setOpen(true)}
          >
            填写变量
          </button>
        </div>
      ) : (
        <div className="mx-5 mt-2.5 flex items-center gap-2 rounded-[10px] bg-[#F4F2EC] px-3 py-2 text-sm text-[#3C3A35] max-md:mx-3">
          <KeyRound className="size-[15px] shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {filledSummary(state) || "这个智能体定义了变量，都是选填的"}
          </span>
          <button
            type="button"
            className="shrink-0 underline decoration-[#C9C4B8] underline-offset-[3px] max-md:min-h-11"
            onClick={() => setOpen(true)}
          >
            管理变量
          </button>
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!busy) setOpen(o);
        }}
      >
        <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>填写变量</DialogTitle>
            <DialogDescription>
              这些参数由智能体定义，运行时自动注入。值按「你 +
              这个智能体」保存，其他人看不到；密钥类型加密存储。
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto">
            {state.variables.map((v) => (
              <label key={v.name} className="block space-y-1">
                <span className="text-sm">
                  {v.name}
                  {v.required && <span className="ml-1 text-destructive">*</span>}
                  {v.secret && <span className="ml-1 text-xs text-muted-foreground">（密钥）</span>}
                </span>
                {v.description && <p className="text-xs text-muted-foreground">{v.description}</p>}
                <Input
                  type={v.secret ? "password" : "text"}
                  value={draft[v.name] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [v.name]: e.target.value })}
                  autoComplete="off"
                  placeholder={
                    v.secret ? (state.values[v.name] ? "已保存，留空不修改" : "输入密钥") : "输入值"
                  }
                />
              </label>
            ))}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="shrink-0">
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
