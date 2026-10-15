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

interface VariableState {
  variables: VariableDef[];
  values: Record<string, string>;
  filled: boolean;
}

export function VariablePrompt({
  agentId,
  onReady,
}: {
  agentId: string;
  onReady?: () => void;
}) {
  const [state, setState] = useState<VariableState | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<VariableState>(
        `/api/agents/${encodeURIComponent(agentId)}/variables`,
      );
      setState(data);
      if (data.variables.length > 0) {
        setDraft(data.values);
      }
    } catch {}
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!state || state.variables.length === 0) return null;

  const missing = state.variables.filter((v) => v.required && !state.values[v.name]?.trim());

  async function save() {
    setBusy(true);
    setError("");
    try {
      await fetchJson(`/api/agents/${encodeURIComponent(agentId)}/variables`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
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
      {missing.length > 0 && (
        <div className="mx-auto mb-3 flex max-w-2xl items-center gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm">
          <KeyRound className="size-4 shrink-0 text-yellow-600" />
          <span>需要填写 {missing.length} 个必填变量才能运行此智能体</span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto shrink-0"
            onClick={() => setOpen(true)}
          >
            填写变量
          </Button>
        </div>
      )}
      {missing.length === 0 && (
        <div className="mx-auto mb-3 flex max-w-2xl items-center gap-2 text-xs text-muted-foreground">
          <KeyRound className="size-3" />
          <button type="button" className="underline" onClick={() => setOpen(true)}>
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
              这些参数由智能体定义，运行时会自动注入。密钥类型加密存储。
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
                  placeholder={v.secret ? "输入密钥" : "输入值"}
                />
              </label>
            ))}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="shrink-0">
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
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
