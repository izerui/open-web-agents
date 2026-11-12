"use client";

// 只读接入视图:不是所有者的人(只读分享、市场使用者)从「API 接入」进来时看到的接入阶段。
// 只给调用方需要的东西 —— 调用地址、入参 / 结果契约、OpenAPI、调用代码、去 API Key 页签 Key;
// 不出现 webhook、Key 列表、在线试调等所有者才有的信息与操作。

import { Button } from "@/components/ui/button";
import { type SnippetLang, buildSnippets } from "@/features/integration/snippets";
import { cn } from "@/lib/utils";
import { Braces, KeyRound, Link2, Lock, SquareTerminal } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { STAGES } from "./build-model";
import { Banner, Block, CodeBlock, CopyButton, StageTitle, Tag } from "./ui";
import type { BuildAgent } from "./use-build-data";

type Schema = Record<string, unknown> | null | undefined;

/** 只读者能看的阶段:编排(只读配置)与接入(调用说明) */
export const READONLY_STAGES = STAGES.filter((s) => s.key === "orch" || s.key === "access");
/** 只读者的接入阶段只有调用说明,不显示所有者的签 Key 状态 */
export const READONLY_ACCESS_BADGE = { text: "调用说明", tone: "" } as const;

export function ReadonlyAccess({ agent }: { agent: BuildAgent }) {
  const [lang, setLang] = useState<SnippetLang>("curl");
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  // 调用方默认拿到已发布版本的契约;从未发布(只读分享的草稿)退回配置里的
  const contract = (agent.published ?? agent.config) as {
    inputSchema?: Schema;
    outputSchema?: Schema;
  };
  const inputSchema = contract.inputSchema ?? null;
  const outputSchema = contract.outputSchema ?? null;
  const version = agent.publishedVersion ?? null;
  const id = agent.id;
  const invokeUrl = `${origin}/api/agents/${encodeURIComponent(id)}/invoke`;
  const openapi = `/api/agents/${encodeURIComponent(id)}/openapi.json`;
  const snippets = useMemo(
    () =>
      buildSnippets({
        origin,
        agentId: id,
        inputSchema,
        hasOutputSchema: Boolean(outputSchema),
      }),
    [origin, id, inputSchema, outputSchema],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-7 max-md:px-3.5">
      <div className="mx-auto max-w-[920px]">
        <StageTitle
          title="接入"
          desc={
            <>
              <div className="mb-1.5">用 API 从你的系统里调用「{agent.name}」。</div>
              <div className="flex flex-wrap gap-1.5">
                <Tag tone={version !== null ? "ok" : "warn"}>
                  {version !== null ? `已发布 v${version}` : "未发布，调用使用草稿"}
                </Tag>
                <Tag>{inputSchema ? "结构化入参" : "文本入参"}</Tag>
                <Tag>{outputSchema ? "结构化结果 structured" : "文本结果 text"}</Tag>
              </div>
            </>
          }
        />
        <Banner icon={<Lock />}>
          你不是这个智能体的所有者：这里只有调用说明。签一个限定它的 API Key
          就能调用，花费记在你的账户上。
        </Banner>

        <Block icon={<Link2 />} title="调用地址">
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-[#F6F5F1] px-3 py-2">
            <span className="rounded-md bg-[#E6EEF6] px-2 py-0.5 font-mono text-xs font-semibold text-[#2B5278]">
              POST
            </span>
            <span className="min-w-0 flex-1 font-mono text-[13px] [overflow-wrap:anywhere]">
              {invokeUrl}
            </span>
            <CopyButton text={invokeUrl} label="复制地址" done="调用地址已复制" />
          </div>
          <p className="mt-2 mb-0 text-sm text-muted-foreground">
            {version !== null ? (
              <>
                不传 version 时调用当前发布版 v{version}
                ，作者发布新版本后自动切换；需要固定某一版时在请求体里加{" "}
                <span className="font-mono text-foreground">"version": {version}</span>。
              </>
            ) : (
              "还没发布：调用直接跑作者的草稿，作者一改调用结果就可能变化。"
            )}
          </p>
        </Block>

        <Block icon={<KeyRound />} title="签一个 API Key">
          <p className="mt-1.5 mb-3 text-sm text-muted-foreground">
            在 API Key 页签发，用途选这个智能体（ID：
            <span className="font-mono text-foreground">{id}</span>
            ）。Key 只在后端用，明文只显示一次。
          </p>
          <Button asChild className="max-md:h-11">
            <Link href="/developer/keys">
              <KeyRound />去 API Key 页签发
            </Link>
          </Button>
        </Block>

        <Block
          icon={<Braces />}
          title="入参与结果契约"
          right={
            <a
              className="font-mono text-[13px] underline"
              href={openapi}
              target="_blank"
              rel="noreferrer"
            >
              OpenAPI 文档
            </a>
          }
        >
          <div className="mt-2.5 grid gap-3 md:grid-cols-2">
            <SchemaBox
              label="入参 inputSchema"
              schema={inputSchema}
              empty="未声明，按自由文本传 input。"
            />
            <SchemaBox
              label="结果 outputSchema"
              schema={outputSchema}
              empty="未声明，结果在 text 字段里。"
            />
          </div>
        </Block>

        <Block
          icon={<SquareTerminal />}
          title="调用代码"
          right={
            <Tag tone={snippets.sample.valid ? "ok" : "warn"}>
              {inputSchema
                ? snippets.sample.valid
                  ? "示例入参按 inputSchema 生成，已通过校验"
                  : "示例入参需要按实际填写"
                : "文本入参"}
            </Tag>
          }
        >
          <div className="mt-2 mb-2 flex items-center gap-1 border-b border-line-soft">
            {(
              [
                ["curl", "curl"],
                ["python", "Python"],
                ["node", "Node"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={lang === k}
                onClick={() => setLang(k)}
                className={cn(
                  "-mb-px h-10 border-b-2 border-transparent px-3.5 text-sm text-muted-foreground max-md:h-11",
                  lang === k && "border-foreground font-medium text-foreground",
                )}
              >
                {label}
              </button>
            ))}
            <CopyButton className="ml-auto" text={snippets[lang]} done="代码已复制" />
          </div>
          <CodeBlock className="max-h-[300px]">{snippets[lang]}</CodeBlock>
        </Block>
      </div>
    </div>
  );
}

function SchemaBox({ label, schema, empty }: { label: string; schema: Schema; empty: string }) {
  const text = schema ? JSON.stringify(schema, null, 2) : "";
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center justify-between text-[13px] font-semibold">
        {label}
        {text && <CopyButton text={text} done={`已复制${label}`} />}
      </div>
      {text ? (
        <CodeBlock className="max-h-64">{text}</CodeBlock>
      ) : (
        <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
          {empty}
        </div>
      )}
    </div>
  );
}
