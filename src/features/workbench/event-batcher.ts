import type { AgentEvent } from "@/lib/shared";

export interface EventBatcher {
  push(event: AgentEvent): void;
  flush(): void;
  cancel(): void;
}

export function createEventBatcher(
  commit: (events: AgentEvent[]) => void,
  schedule: (callback: () => void) => number = requestAnimationFrame,
  cancelSchedule: (handle: number) => void = cancelAnimationFrame,
): EventBatcher {
  let queued: AgentEvent[] = [];
  let handle: number | null = null;

  const flush = () => {
    if (handle !== null) {
      cancelSchedule(handle);
      handle = null;
    }
    if (queued.length === 0) return;
    const events = queued;
    queued = [];
    commit(events);
  };

  return {
    push(event) {
      queued.push(event);
      if (handle === null) {
        handle = schedule(() => {
          handle = null;
          if (queued.length === 0) return;
          const events = queued;
          queued = [];
          commit(events);
        });
      }
    },
    flush,
    cancel() {
      if (handle !== null) cancelSchedule(handle);
      handle = null;
      queued = [];
    },
  };
}
