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
import { ExternalLink, Sparkles, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface Issue {
  field: string;
  message: string;
}

/**
 * 设计会话的操作条:把设计师写在工作目录里的智能体定义应用到平台,然后去试运行。
 *
 * 设计师自己改不了平台配置 —— 写回必须由人点这一下,并经过与构建器保存相同的校验。
 * 校验不通过时,问题可以一键发回给设计师修复,形成"对话 → 应用 → 试运行 → 再对话"的循环。
 */
export function DesignBar({
  sessionId,
  disabled,
  onAskFix,
}: {
  sessionId: string;
  /** 设计师还在改文件时不要应用(会读到改了一半的文件)。 */
  disabled: boolean;
  onAskFix: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<{ id: string; name: string } | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);

  async function apply() {
    setBusy(true);
    try {
      const res = await fetch("/api/agents/design/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        agent?: { id: string; name: string };
        created?: boolean;
        error?: string;
        issues?: Issue[];
      };
      if (!res.ok || !data.agent) {
        if (data.issues?.length) setIssues(data.issues);
        else toast.error(`应用失败:${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setApplied(data.agent);
      toast.success(
        data.created ? `已创建智能体「${data.agent.name}」` : `已更新「${data.agent.name}」`,
      );
    } catch (e) {
      toast.error(`应用失败:${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-brand/5 px-4 py-2 text-xs">
        <Sparkles className="size-3.5 text-brand" />
        <span className="text-muted-foreground">
          智能体设计会话:设计师改的是工作目录里 agent/ 下的定义,点「应用」才会写入平台。
        </span>
        <div className="ml-auto flex items-center gap-2">
          {applied && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => window.open(`/?agent=${encodeURIComponent(applied.id)}`, "_blank")}
            >
              <ExternalLink className="size-3.5" />
              试运行「{applied.name}」
            </Button>
          )}
          <Button
            size="sm"
            className="h-7"
            disabled={busy || disabled}
            title={disabled ? "设计师还在修改,完成后再应用" : undefined}
            onClick={() => void apply()}
          >
            <Upload className="size-3.5" />
            {busy ? "校验中…" : applied ? "再次应用" : "应用到智能体"}
          </Button>
        </div>
      </div>

      <Dialog open={issues !== null} onOpenChange={(o) => !o && setIssues(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>还不能应用:定义有 {issues?.length ?? 0} 处问题</DialogTitle>
            <DialogDescription>可以直接发给设计师,让它照着修改。</DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
            {issues?.map((i) => (
              <li
                key={`${i.field}-${i.message}`}
                className="rounded border border-border px-2 py-1"
              >
                <span className="font-mono text-muted-foreground">{i.field}</span> {i.message}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIssues(null)}>
              关闭
            </Button>
            <Button
              onClick={() => {
                const text = `应用时校验没通过,请修复这些问题:\n${(issues ?? [])
                  .map((i) => `- ${i.field}:${i.message}`)
                  .join("\n")}`;
                setIssues(null);
                onAskFix(text);
              }}
            >
              发给设计师修复
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
