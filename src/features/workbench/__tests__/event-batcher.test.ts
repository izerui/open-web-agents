import { createEventBatcher } from "@/features/workbench/event-batcher";
import type { AgentEvent } from "@/lib/shared";
import { describe, expect, it } from "vitest";

describe("createEventBatcher", () => {
  it("把同一帧内的事件合并成一次提交", () => {
    const callbacks: Array<() => void> = [];
    const commits: AgentEvent[][] = [];
    const batcher = createEventBatcher(
      (events) => commits.push(events),
      (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      () => {},
    );

    batcher.push({ kind: "text", text: "a" });
    batcher.push({ kind: "text", text: "b" });
    expect(commits).toEqual([]);
    callbacks[0]?.();
    expect(commits).toEqual([
      [
        { kind: "text", text: "a" },
        { kind: "text", text: "b" },
      ],
    ]);
  });

  it("flush 会立即提交最后一批事件", () => {
    const commits: AgentEvent[][] = [];
    const batcher = createEventBatcher(
      (events) => commits.push(events),
      () => 1,
      () => {},
    );
    batcher.push({ kind: "result", status: "success" });
    batcher.flush();
    expect(commits).toEqual([[{ kind: "result", status: "success" }]]);
  });
});
