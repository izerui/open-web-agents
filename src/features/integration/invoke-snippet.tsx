"use client";

import { Copy } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type SnippetLang, buildSnippets } from "@/features/integration/snippets";

const TABS: { key: SnippetLang; label: string }[] = [
  { key: "curl", label: "curl" },
  { key: "python", label: "Python" },
  { key: "node", label: "Node.js" },
  { key: "embed", label: "嵌入组件" },
];

/**
 * 按智能体生成的接入代码:curl / Python / Node / 嵌入组件。
 * 示例入参过了该智能体的 inputSchema 校验才说"可直接运行";过不了就明说要按实际填写。
 */
export function InvokeSnippetTabs({
  agentId,
  inputSchema,
  hasOutputSchema,
}: {
  agentId: string;
  inputSchema?: Record<string, unknown> | null;
  hasOutputSchema: boolean;
}) {
  const snippets = useMemo(
    () =>
      buildSnippets({
        origin: typeof window === "undefined" ? "" : window.location.origin,
        agentId,
        inputSchema,
        hasOutputSchema,
      }),
    [agentId, inputSchema, hasOutputSchema],
  );

  const { sample } = snippets;

  return (
    <Tabs defaultValue="curl" className="gap-2">
      {sample.valid ? (
        <p className="text-xs text-muted-foreground">
          示例入参已通过该智能体的输入契约校验,设置好 OWA_API_KEY 即可直接运行。
        </p>
      ) : (
        <Alert className="border-warning/40 bg-warning/10 text-xs">
          <AlertTitle className="text-xs">
            示例入参需要按实际填写:自动生成的值没有通过该智能体的输入契约(inputSchema)校验。
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4 text-xs">
              {sample.issues.slice(0, 5).map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <TabsList>
        {TABS.map((t) => (
          <TabsTrigger key={t.key} value={t.key} className="text-xs">
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {TABS.map((t) => (
        <TabsContent key={t.key} value={t.key} className="space-y-2">
          <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {snippets[t.key]}
          </pre>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(snippets[t.key])
                .then(() => toast.success("已复制"))
                .catch(() => toast.error("复制失败,请手动选择文本"))
            }
          >
            <Copy className="size-3.5" />
            复制
          </Button>
        </TabsContent>
      ))}
    </Tabs>
  );
}
