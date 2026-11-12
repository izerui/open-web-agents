"use client";

// 技能包编辑(原 Builder 的 SkillEditor):技能名、何时使用、SKILL.md 正文、附属文件(增删改与路径校验)。

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, FileCode, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { type SkillDraft, newFilePathError } from "./profile-model";
import { Field, TextButton, inputMono } from "./ui";

export function SkillItem({
  skill,
  onPatch,
  onDelete,
}: {
  skill: SkillDraft;
  onPatch: (next: Partial<SkillDraft>) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(!skill.name);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [newPath, setNewPath] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);
  const others = Object.keys(skill.files).filter((p) => p !== "SKILL.md");
  const nameBad = skill.name !== "" && !/^[a-z0-9-]+$/.test(skill.name);
  const patchFile = (path: string, content: string) =>
    onPatch({ files: { ...skill.files, [path]: content } });

  function addFile() {
    const err = newFilePathError(newPath, skill.files);
    if (err) return setPathError(err);
    const p = newPath.trim();
    patchFile(p, "");
    setNewPath("");
    setPathError(null);
    setOpenFile(p);
  }

  return (
    <div className="mb-2 rounded-xl border border-border bg-card">
      <div className="flex min-h-12 items-center gap-2.5 px-3 py-2.5">
        <FileCode className="size-4 shrink-0 text-muted-foreground" />
        <b className={cn("shrink-0 font-semibold", inputMono)}>{skill.name || "未命名"}</b>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {skill.description}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground max-sm:hidden">
          {others.length} 个附属文件
        </span>
        <TextButton onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "收起" : "编辑"}
        </TextButton>
        <TextButton aria-label={`删除技能包 ${skill.name || "未命名"}`} onClick={onDelete}>
          <Trash2 />
        </TextButton>
      </div>
      {open && (
        <div className="border-t border-line-soft px-3.5 pt-2.5 pb-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="技能名（小写字母、数字、连字符）"
              error={nameBad ? "只能用小写字母、数字和连字符" : undefined}
            >
              <Input
                className={inputMono}
                aria-label="技能名"
                value={skill.name}
                onChange={(e) => onPatch({ name: e.target.value })}
                placeholder="invoice-ocr"
              />
            </Field>
            <Field label="何时使用">
              <Input
                aria-label="技能描述"
                value={skill.description}
                onChange={(e) => onPatch({ description: e.target.value })}
                placeholder="需要识别发票字段时使用"
              />
            </Field>
          </div>
          <div className="mb-2 flex items-center justify-between text-[13px]">
            <TextButton
              className="pl-0 font-medium"
              aria-expanded={openFile === "SKILL.md"}
              onClick={() => setOpenFile(openFile === "SKILL.md" ? null : "SKILL.md")}
            >
              {openFile === "SKILL.md" ? <ChevronDown /> : <ChevronRight />}
              SKILL.md
            </TextButton>
            <span className="text-muted-foreground">
              {(skill.files["SKILL.md"] ?? "").length.toLocaleString()} 字
            </span>
          </div>
          {openFile === "SKILL.md" && (
            <Textarea
              className={cn("mb-2 min-h-40 resize-y", inputMono)}
              aria-label="SKILL.md 正文"
              value={skill.files["SKILL.md"] ?? ""}
              onChange={(e) => patchFile("SKILL.md", e.target.value)}
              placeholder="步骤、约定、示例"
            />
          )}
          <div className="mt-2 mb-1 text-[13px] font-semibold">附属文件</div>
          <div>
            {others.length === 0 && (
              <p className="py-1.5 text-sm text-muted-foreground">还没有附属文件</p>
            )}
            {others.map((path) => (
              <div key={path} className="border-b border-dashed border-line-soft last:border-0">
                <div className="flex items-center gap-2 py-1.5 text-[13px]">
                  <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className={cn("min-w-0 truncate", inputMono)}>{path}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {(skill.files[path] ?? "").length} 字
                  </span>
                  <span className="flex-1" />
                  <TextButton onClick={() => setOpenFile(openFile === path ? null : path)}>
                    {openFile === path ? "收起" : "编辑"}
                  </TextButton>
                  <TextButton
                    aria-label={`删除 ${path}`}
                    onClick={() => {
                      const { [path]: _, ...rest } = skill.files;
                      onPatch({ files: rest });
                      if (openFile === path) setOpenFile(null);
                    }}
                  >
                    <Trash2 />
                  </TextButton>
                </div>
                {openFile === path && (
                  <Textarea
                    className={cn("mb-2 min-h-32 resize-y", inputMono)}
                    aria-label={`${path} 内容`}
                    value={skill.files[path] ?? ""}
                    onChange={(e) => patchFile(path, e.target.value)}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <Input
                className={inputMono}
                aria-label="新文件路径"
                value={newPath}
                onChange={(e) => {
                  setNewPath(e.target.value);
                  setPathError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addFile();
                  }
                }}
                placeholder="新文件路径，如 templates/rules.md"
              />
              {pathError && <p className="mt-1 text-xs text-destructive">{pathError}</p>}
            </div>
            <button
              type="button"
              onClick={addFile}
              className="inline-flex h-[38px] shrink-0 items-center gap-1 rounded-full border border-border bg-card px-3 text-[13px] hover:bg-[#F2F0EA]"
            >
              <Plus className="size-3.5" />
              添加文件
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
