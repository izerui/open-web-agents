"use client";

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputTextarea,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { takeAttachments } from "@/lib/attachment-handoff";
import { cn } from "@/lib/utils";
import { ArrowUp, Clock, File, Image, Paperclip, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ContextWindowMeter } from "./context-window-meter";

export interface SlashCommand {
  name: string;
  label: string;
  icon: React.ElementType;
  disabled?: boolean;
  run(): void;
}

export interface QueuedMessage {
  id: string;
  text: string;
  files: unknown[];
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function SlashMenu({
  commands,
  activeIndex,
  onSelect,
}: {
  commands: SlashCommand[];
  activeIndex: number;
  onSelect(command: SlashCommand): void;
}) {
  return (
    <div
      id="slash-commands"
      className="absolute bottom-full left-0 z-20 mb-1.5 w-[300px] max-w-full rounded-xl border border-border bg-card p-1.5 shadow-[0_10px_30px_rgb(0_0_0/8%)]"
    >
      <p className="px-2.5 pt-1 pb-0.5 text-xs text-muted-foreground">
        命令，↑↓ 选择，回车执行，Esc 关闭
      </p>
      {commands.length === 0 && (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">没有匹配的命令</p>
      )}
      {commands.map((command, index) => (
        <button
          key={command.name}
          type="button"
          aria-current={index === activeIndex ? "true" : undefined}
          disabled={command.disabled}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm disabled:opacity-40",
            index === activeIndex ? "bg-[#EFEDE7]" : "hover:bg-[#F4F2EC]",
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(command)}
        >
          <command.icon className="size-[15px] text-muted-foreground" />
          <b className="w-16 font-mono font-semibold">/{command.name}</b>
          <span className="text-muted-foreground">{command.label}</span>
        </button>
      ))}
    </div>
  );
}

/** 探索首页「立即使用」带来的附件:打开的正是那个会话时放进附件条(见 lib/attachment-handoff) */
function HandedOffAttachments() {
  const { add } = usePromptInputAttachments();
  // biome-ignore lint/correctness/useExhaustiveDependencies: take once on mount
  useEffect(() => {
    const files = takeAttachments(new URLSearchParams(window.location.search).get("session"));
    if (files.length) add(files);
  }, []);
  return null;
}

function AttachmentChips() {
  const { files, remove } = usePromptInputAttachments();
  if (files.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="待发送的附件">
      {files.map((file) => (
        <li
          key={file.id}
          className="inline-flex h-[22px] items-center gap-1 rounded-full border border-border pr-0.5 pl-2 text-xs text-muted-foreground"
        >
          {file.mediaType?.startsWith("image/") ? (
            <Image className="size-3" />
          ) : (
            <File className="size-3" />
          )}
          <span className="max-w-48 truncate">{file.filename ?? "附件"}</span>
          <button
            type="button"
            aria-label={`移除附件 ${file.filename ?? ""}`}
            onClick={() => remove(file.id)}
            className="flex size-[18px] items-center justify-center rounded-full hover:bg-[#DDD9CF]"
          >
            <X className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 添加附件:先弹一个小菜单说明大小上限与拖放,再打开系统选择框 */
function AttachButton({ disabled }: { disabled: boolean }) {
  const { openFileDialog } = usePromptInputAttachments();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] whitespace-nowrap text-[#4D4A43] hover:bg-[#EFEDE7] disabled:cursor-not-allowed disabled:opacity-40 max-md:size-11 max-md:justify-center max-md:px-0"
        >
          <Paperclip className="size-[15px]" />
          <span className="max-md:sr-only">添加图片或文件</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[250px] p-1.5">
        <p className="px-2.5 pt-1.5 pb-0.5 text-xs text-muted-foreground">单个文件不超过 10MB</p>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            openFileDialog();
          }}
          className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-[#F4F2EC] max-md:min-h-11"
        >
          <Image className="size-[15px] text-muted-foreground" />
          选择图片或文件
        </button>
        <p className="px-2.5 pt-0.5 pb-1.5 text-xs text-muted-foreground">
          也可以把文件直接拖进窗口，发送时上传到这个会话的工作目录
        </p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 输入框:白色大圆角;附件、上下文用量、发送 / 停止;斜杠命令;运行中可继续补充(交给运行中的智能体或排队)。
 */
export function Composer({
  input,
  onInputChangeAction,
  running,
  blocked,
  placeholder,
  onSubmitAction,
  onStopAction,
  commands,
  queued,
  onUnqueueAction,
  contextUsed,
  totalProcessed,
}: {
  input: string;
  onInputChangeAction: (value: string) => void;
  running: boolean;
  /** 不能发送(没有可用智能体、历史没读到、已归档) */
  blocked: boolean;
  placeholder: string;
  onSubmitAction: (message: PromptInputMessage) => void | Promise<void>;
  onStopAction: () => void;
  commands: SlashCommand[];
  queued: QueuedMessage[];
  onUnqueueAction: (id: string) => void;
  contextUsed: number;
  totalProcessed: number | null;
}) {
  const [slashIndex, setSlashIndex] = useState(0);
  /** Esc 只关菜单、不清空输入;再改输入时菜单重新出现 */
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashOpen = /^\/[^\s]*$/.test(input) && !slashDismissed;
  const query = slashOpen ? input.slice(1).toLocaleLowerCase() : "";
  const matching = slashOpen ? commands.filter((c) => c.name.startsWith(query)) : [];
  const active = Math.min(slashIndex, Math.max(0, matching.length - 1));
  const select = (command: SlashCommand) => {
    if (command.disabled) return;
    onInputChangeAction("");
    setSlashIndex(0);
    command.run();
  };

  return (
    <div className="shrink-0">
      {queued.length > 0 && (
        <div className="mx-5 mb-2 rounded-xl border border-border bg-[#FBFAF7] px-2 py-1.5 max-md:mx-3">
          <p className="flex items-center gap-1.5 px-1.5 pt-0.5 pb-1 text-[12.5px] text-muted-foreground">
            <Clock className="size-3.5" />
            排队 {queued.length}，本轮结束后按顺序发送
          </p>
          <ul aria-label="排队中的消息">
            {queued.map((q) => (
              <li
                key={q.id}
                className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-[#F1EFE9]"
              >
                <span className="min-w-0 flex-1 truncate">{q.text}</span>
                {q.files.length > 0 && (
                  <span className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border border-border px-2 text-xs text-muted-foreground">
                    <Paperclip className="size-3" />
                    {q.files.length} 个附件
                  </span>
                )}
                <button
                  type="button"
                  aria-label="取消这条排队消息"
                  onClick={() => onUnqueueAction(q.id)}
                  className="flex size-[26px] shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-[#E6E3DB] hover:text-foreground max-md:size-11"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="relative mx-5 mb-4 max-md:mx-3 max-md:mb-3">
        {slashOpen && <SlashMenu commands={matching} activeIndex={active} onSelect={select} />}
        <PromptInput
          globalDrop
          multiple
          maxFileSize={MAX_UPLOAD_BYTES}
          onError={(err) => {
            toast.error(
              err.code === "max_file_size"
                ? "文件超过 10MB，没有添加"
                : err.code === "max_files"
                  ? "附件太多了"
                  : "这个文件不能添加",
            );
          }}
          onSubmit={onSubmitAction}
          className="[&_[data-slot=input-group]]:h-auto [&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:border-border [&_[data-slot=input-group]]:bg-card [&_[data-slot=input-group]]:shadow-none"
        >
          <PromptInputHeader className="px-3.5 pt-2.5 pb-0 empty:hidden">
            <AttachmentChips />
            <HandedOffAttachments />
          </PromptInputHeader>
          <PromptInputBody>
            <PromptInputTextarea
              aria-label="消息"
              className="min-h-11 px-3.5 pt-2.5 text-[14.5px] leading-[1.55] max-md:text-base"
              value={input}
              onChange={(event) => {
                onInputChangeAction(event.target.value);
                setSlashIndex(0);
                setSlashDismissed(false);
              }}
              onKeyDown={(event) => {
                if (!slashOpen) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
                if (matching.length === 0) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSlashIndex((index) => (index + 1) % matching.length);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSlashIndex((index) => (index - 1 + matching.length) % matching.length);
                } else if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const command = matching[active];
                  if (command) select(command);
                }
              }}
              disabled={blocked}
              placeholder={placeholder}
            />
          </PromptInputBody>
          <PromptInputFooter className="gap-2 px-2 pt-1 pb-2">
            <AttachButton disabled={blocked} />
            <ContextWindowMeter
              usedTokens={contextUsed}
              maxTokens={200_000}
              totalProcessed={totalProcessed}
            />
            <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground max-md:hidden">
              {running ? "回车追加，Shift+回车换行" : "回车发送，Shift+回车换行"}
            </span>
            <span className="flex-1 md:hidden" />
            {running && (
              <button
                type="button"
                aria-label="停止运行"
                title="停止这一轮"
                onClick={onStopAction}
                className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-black max-md:size-11"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            )}
            <button
              type="submit"
              aria-label={running ? "追加消息" : "发送消息"}
              title={running ? "交给正在运行的智能体" : "发送"}
              disabled={blocked}
              className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-black disabled:cursor-not-allowed disabled:bg-[#E3E0D8] disabled:text-[#57544D] max-md:size-11"
            >
              <ArrowUp className="size-4" strokeWidth={2} />
            </button>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
