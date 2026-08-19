import { shouldChainComposerWheel } from "@/components/ai-elements/composer-interactions";
import { describe, expect, it } from "vitest";

describe("shouldChainComposerWheel", () => {
  it("keeps wheel input in a draft that can still scroll", () => {
    expect(
      shouldChainComposerWheel({
        scrollTop: 40,
        clientHeight: 100,
        scrollHeight: 300,
        deltaY: 20,
      }),
    ).toBe(false);
    expect(
      shouldChainComposerWheel({
        scrollTop: 40,
        clientHeight: 100,
        scrollHeight: 300,
        deltaY: -20,
      }),
    ).toBe(false);
  });

  it("chains upward wheel input at the top boundary", () => {
    expect(
      shouldChainComposerWheel({
        scrollTop: 0,
        clientHeight: 100,
        scrollHeight: 300,
        deltaY: -20,
      }),
    ).toBe(true);
  });

  it("chains downward wheel input at the bottom boundary", () => {
    expect(
      shouldChainComposerWheel({
        scrollTop: 199,
        clientHeight: 100,
        scrollHeight: 300,
        deltaY: 20,
      }),
    ).toBe(true);
  });

  it("uses a one-pixel tolerance for fractional scroll geometry", () => {
    expect(
      shouldChainComposerWheel({
        scrollTop: 199.2,
        clientHeight: 100,
        scrollHeight: 300,
        deltaY: 1,
      }),
    ).toBe(true);
  });

  it("ignores horizontal-only wheel events", () => {
    expect(
      shouldChainComposerWheel({
        scrollTop: 0,
        clientHeight: 100,
        scrollHeight: 100,
        deltaY: 0,
      }),
    ).toBe(false);
  });
});
