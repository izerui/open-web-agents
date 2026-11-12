import { describe, expect, it } from "vitest";
import { AUTOSAVE_DELAY_MS, type AutosaveState, INITIAL_AUTOSAVE, autosaveStep } from "../autosave";

function run(events: Parameters<typeof autosaveStep>[1][], from: AutosaveState = INITIAL_AUTOSAVE) {
  const effects: string[] = [];
  let s = from;
  for (const e of events) {
    const r = autosaveStep(s, e);
    s = r.state;
    if (r.effect) effects.push(r.effect);
  }
  return { state: s, effects };
}

describe("autosaveStep:字段停顿约 800ms 后保存", () => {
  it("延迟是 800ms", () => {
    expect(AUTOSAVE_DELAY_MS).toBe(800);
  });

  it("改动后先排定计时,计时到了才保存", () => {
    const r = run([{ type: "edit", blocked: false }]);
    expect(r.state.phase).toBe("pending");
    expect(r.effects).toEqual(["schedule"]);
    const r2 = run([{ type: "timer" }], r.state);
    expect(r2.state.phase).toBe("saving");
    expect(r2.effects).toEqual(["save"]);
  });

  it("连续改动只重新计时,只存一次", () => {
    const r = run([
      { type: "edit", blocked: false },
      { type: "edit", blocked: false },
      { type: "edit", blocked: false },
      { type: "timer" },
    ]);
    expect(r.effects).toEqual(["schedule", "schedule", "schedule", "save"]);
  });

  it("保存中又改动:等这次存完再存一次", () => {
    const r = run([
      { type: "edit", blocked: false },
      { type: "timer" },
      { type: "edit", blocked: false },
    ]);
    expect(r.state.phase).toBe("saving");
    expect(r.state.queued).toBe(true);
    const r2 = run([{ type: "saved", at: 5, blocked: false }], r.state);
    expect(r2.state.phase).toBe("pending");
    expect(r2.state.savedAt).toBe(5);
    expect(r2.effects).toEqual(["schedule"]);
  });

  it("存完没有新改动就回到空闲并记下时间", () => {
    const r = run([{ type: "edit", blocked: false }, { type: "timer" }, { type: "saved", at: 9, blocked: false }]);
    expect(r.state).toMatchObject({ phase: "idle", savedAt: 9, queued: false });
  });

  it("被闸门挡住(名称或提示词为空、Schema 非法……):暂停,不保存;解除后恢复", () => {
    const r = run([{ type: "edit", blocked: false }, { type: "edit", blocked: true }]);
    expect(r.state.phase).toBe("blocked");
    expect(r.effects).toEqual(["schedule", "cancel"]);
    expect(run([{ type: "timer" }], r.state).effects).toEqual([]);
    const r2 = run([{ type: "edit", blocked: false }], r.state);
    expect(r2.state.phase).toBe("pending");
    expect(r2.effects).toEqual(["schedule"]);
  });

  it("保存中改成被挡住:存完进入暂停", () => {
    const r = run([
      { type: "edit", blocked: false },
      { type: "timer" },
      { type: "edit", blocked: true },
      { type: "saved", at: 3, blocked: true },
    ]);
    expect(r.state.phase).toBe("blocked");
  });

  it("失败:记下原因,可以重试;再改动也会重新排定", () => {
    const r = run([{ type: "edit", blocked: false }, { type: "timer" }, { type: "failed", error: "409" }]);
    expect(r.state).toMatchObject({ phase: "error", error: "409" });
    expect(run([{ type: "retry" }], r.state).effects).toEqual(["save"]);
    expect(run([{ type: "edit", blocked: false }], r.state).effects).toEqual(["schedule"]);
  });

  it("立即保存(离开页面、应用设计器改动前):有待存的就马上存", () => {
    const r = run([{ type: "edit", blocked: false }, { type: "flush" }]);
    expect(r.effects).toEqual(["schedule", "save"]);
    expect(run([{ type: "flush" }]).effects).toEqual([]);
  });
});
