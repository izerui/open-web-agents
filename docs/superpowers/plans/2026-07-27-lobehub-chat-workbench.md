# LobeHub Chat Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the homepage chat UI with a responsive LobeHub-style workbench while preserving every existing Open Web Agents conversation behavior.

**Architecture:** Keep the current workbench controller and backend APIs. Add pure adapters that translate `Turn[]` and `AgentEvent[]` into presentation models, then render those models through components built with `@lobehub/ui`, `@lobehub/editor`, `antd-style`, and `lucide-react`. No LobeHub business store or service code enters this repository.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, Vitest, `@lobehub/ui`, `@lobehub/editor`, Ant Design 6, `antd-style`, Lucide.

---

### Task 1: Add UI Dependencies And Providers

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/globals.css`
- Create: `src/features/workbench/workbench-provider.tsx`
- Create: `THIRD_PARTY_NOTICES.md`

- [ ] **Step 1: Install the selected LobeHub UI packages**

Run:

```bash
pnpm add @lobehub/ui@^5.23.0 @lobehub/editor@^4.19.1 antd@6.3.5 antd-style@4.1.0 lucide-react@^1.22.0
```

Expected: `package.json` and `pnpm-lock.yaml` contain the five direct dependencies.

- [ ] **Step 2: Add the client-side UI provider**

Create `workbench-provider.tsx` as a client component wrapping children in the providers required by `@lobehub/ui` and Ant Design. Keep locale `zh-CN`, use system dark mode, and do not add application state.

- [ ] **Step 3: Wire the provider at the root layout**

Wrap `{children}` in `WorkbenchProvider` while preserving metadata and `lang="zh-CN"`.

- [ ] **Step 4: Establish stable global dimensions**

Update `globals.css` so `html`, `body`, and the Next root occupy the viewport, body overflow is hidden, and typography remains system-native.

- [ ] **Step 5: Record third-party source**

Add a notice naming LobeHub, its local source path, and LobeHub Community License. State that migrated code is used for personal research.

- [ ] **Step 6: Verify package integration**

Run:

```bash
pnpm typecheck
pnpm build
```

Expected: both exit 0.

### Task 2: Build The Pure Conversation Adapter With TDD

**Files:**
- Create: `src/features/workbench/conversation-adapter.ts`
- Create: `src/features/workbench/__tests__/conversation-adapter.test.ts`
- Modify: `src/features/workbench/types.ts`

- [ ] **Step 1: Write failing tests for message adaptation**

Cover:

```ts
adaptTurns([
  {
    prompt: "检查权限",
    running: false,
    events: [
      { kind: "tool_use", tool: "Read", toolUseId: "t1", input: { file_path: "a.ts" } },
      { kind: "tool_result", toolUseId: "t1", text: "ok" },
      { kind: "text", text: "完成" },
    ],
  },
]);
```

Assert that the result contains a user message and an assistant turn with a paired immutable tool call.

- [ ] **Step 2: Run the adapter test and verify RED**

Run:

```bash
pnpm vitest run src/features/workbench/__tests__/conversation-adapter.test.ts
```

Expected: FAIL because `adaptTurns` does not exist.

- [ ] **Step 3: Implement minimal presentation types and adapter**

Define discriminated view models for text, thinking, tool call, question, status, artifact, result, and usage. Clone data instead of mutating source events.

- [ ] **Step 4: Add failing tests for edge cases**

Cover unmatched tool results, subagent labels, question identity, result three-state behavior, and usage de-duplication by `messageId`.

- [ ] **Step 5: Implement edge-case handling**

Make every adapter branch total and deterministic. Fall back to standalone events when pairing is impossible.

- [ ] **Step 6: Verify GREEN**

Run the adapter test again and expect all cases to pass.

### Task 3: Create The Responsive Workbench Shell

**Files:**
- Create: `src/features/workbench/components/app-rail.tsx`
- Create: `src/features/workbench/components/session-sidebar.tsx`
- Create: `src/features/workbench/components/chat-header.tsx`
- Create: `src/features/workbench/components/workbench-shell.tsx`
- Modify: `src/features/workbench/workbench.tsx`

- [ ] **Step 1: Create structural components**

Use `Flexbox`, `ActionIcon`, `Avatar`, `Tooltip`, and Lucide icons. Keep navigation commands linked to `/`, `/builder`, `/groups`, `/usage`, and `/settings`.

- [ ] **Step 2: Move assistant and session controls into `SessionSidebar`**

Props must contain plain data and callbacks only:

```ts
interface SessionSidebarProps {
  assistantId: string;
  assistants: AssistantSummary[];
  disabled: boolean;
  onAssistantChange(id: string): void;
  onNewSession(): void;
  onOpenSession(id: string): void;
  sessionId: string | null;
  sessions: SessionSummary[];
}
```

- [ ] **Step 3: Implement desktop and mobile shell behavior**

Desktop: rail + 260px session sidebar + flexible chat + optional 300px inspector.

Mobile: hide rail/sidebar, show fixed-size header buttons that open drawers.

- [ ] **Step 4: Integrate without changing send logic**

Replace only the JSX layout in `Workbench`; keep its fetch, send, cancel, branch, and file refresh functions behaviorally unchanged.

- [ ] **Step 5: Run typecheck**

Expected: exit 0.

### Task 4: Replace Conversation Rendering

**Files:**
- Create: `src/features/workbench/components/chat-message.tsx`
- Create: `src/features/workbench/components/tool-call-group.tsx`
- Create: `src/features/workbench/components/question-card.tsx`
- Create: `src/features/workbench/components/result-notice.tsx`
- Create: `src/features/workbench/components/conversation-viewport.tsx`
- Create: `src/features/workbench/components/workbench-error-boundary.tsx`
- Modify: `src/features/workbench/conversation.tsx`
- Modify: `src/features/workbench/__tests__/conversation.test.ts`

- [ ] **Step 1: Write failing behavior tests**

Assert that historical questions are disabled, the latest completed question is answerable, and tool results remain paired after later stream events arrive.

- [ ] **Step 2: Implement Lobe-style message shell**

Adapt the layout ideas from LobeHub `Conversation/ChatItem`, but remove all LobeHub store access. Use `@lobehub/ui` `Markdown` for assistant text with a plain-text error fallback.

- [ ] **Step 3: Implement tool and result components**

Tool calls use stable-size collapsible rows. Result notices preserve `success`, `failed`, and `unknown` as distinct visual states.

- [ ] **Step 4: Preserve interactive questions and rerun**

Move the existing question selection semantics and rerun callback into the new components without changing the outgoing text format.

- [ ] **Step 5: Verify conversation tests**

Run:

```bash
pnpm vitest run src/features/workbench/__tests__/conversation.test.ts src/features/workbench/__tests__/conversation-adapter.test.ts
```

Expected: PASS.

### Task 5: Add The Composer And Run Inspector

**Files:**
- Create: `src/features/workbench/components/workbench-composer.tsx`
- Create: `src/features/workbench/run-inspector-adapter.ts`
- Create: `src/features/workbench/__tests__/run-inspector-adapter.test.ts`
- Create: `src/features/workbench/components/run-inspector.tsx`
- Modify: `src/features/workbench/workbench.tsx`
- Modify: `src/features/workbench/file-panel.tsx`

- [ ] **Step 1: Write failing inspector adapter tests**

Given turns with status, tools, subagents, usage, and artifacts, assert totals and current state.

- [ ] **Step 2: Implement the pure inspector adapter**

Return:

```ts
{
  artifacts,
  failedTools,
  inputTokens,
  outputTokens,
  status,
  subagents,
  successfulTools,
  totalTools,
}
```

- [ ] **Step 3: Implement the composer**

Use `@lobehub/editor` for the input shell. Expose controlled `value`, `disabled`, `running`, `onChange`, `onSend`, and `onStop`. Enter sends; Shift+Enter inserts a newline.

- [ ] **Step 4: Implement the inspector**

Use tabs or segmented controls for run summary and files. Reuse the existing file API and preview behavior rather than duplicating it.

- [ ] **Step 5: Integrate into the shell**

The inspector is collapsible on desktop and a drawer on mobile. The stop button must call the existing server cancel path.

- [ ] **Step 6: Verify adapter tests and typecheck**

Expected: all pass.

### Task 6: Responsive And End-To-End Verification

**Files:**
- Modify: `src/app/globals.css`
- Modify: `src/features/workbench/components/workbench-shell.tsx`
- Modify: `src/features/workbench/components/session-sidebar.tsx`
- Modify: `src/features/workbench/components/conversation-viewport.tsx`
- Modify: `src/features/workbench/components/workbench-composer.tsx`
- Modify: `src/features/workbench/components/run-inspector.tsx`

- [ ] **Step 1: Run complete engineering checks**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

- [ ] **Step 2: Start the dev server**

Use an available port and keep the session alive.

- [ ] **Step 3: Verify desktop**

At 1440x900, inspect the rail, sidebar, message width, composer, inspector, long Markdown, tool parameters, and files.

- [ ] **Step 4: Verify tablet and mobile**

At 768x1024 and 390x844, confirm drawers replace fixed sidebars, controls do not overlap, and no horizontal scroll appears.

- [ ] **Step 5: Verify interactions**

Test send, stop, assistant switch, session switch, question selection, rerun, inspector toggle, and file preview.

- [ ] **Step 6: Re-run full checks after visual fixes**

All commands from Step 1 must still exit 0.
