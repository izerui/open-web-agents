import { type Db, databaseProbe } from "@/lib/db/client";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("databaseProbe", () => {
  afterEach(() => vi.useRealTimers());

  it("caller timeouts do not accumulate queries; a completed query allows the next probe", async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const execute = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const probe = databaseProbe({ execute } as unknown as Db);

    for (let i = 0; i < 5; i++) {
      const response = Promise.race([
        probe().then(() => "ready"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
      ]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await response).toBe("timeout");
      expect(execute).toHaveBeenCalledTimes(1);
    }

    const pending = probe();
    complete();
    await pending;
    await probe();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("a driver error releases the probe so a later health check can recover", async () => {
    let fail!: (error: Error) => void;
    const execute = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const probe = databaseProbe({ execute } as unknown as Db);
    const checks = Promise.allSettled([probe(), probe()]);
    fail(new Error("connection lost"));
    expect((await checks).map((check) => check.status)).toEqual(["rejected", "rejected"]);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(probe()).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
