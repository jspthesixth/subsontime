import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySharedState } from "./shared-state.ts";
import { sharedSingleFlight } from "./single-flight.ts";

const later = (ms: number, value: string) =>
  new Promise<string>((resolve) => setTimeout(() => resolve(value), ms));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sharedSingleFlight", () => {
  it("shares one run between callers on one instance before asking the shared state", async () => {
    const state = memorySharedState();
    const setIfAbsent = vi.spyOn(state, "setIfAbsent");
    const flight = sharedSingleFlight(state);
    const run = vi.fn<() => Promise<string>>(() => later(100, "result"));
    const both = Promise.all([flight("key", run), flight("key", run)]);

    await vi.advanceTimersByTimeAsync(100);

    expect(await both).toEqual(["result", "result"]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(setIfAbsent).toHaveBeenCalledTimes(1);
  });

  it("answers with another instance's result without running", async () => {
    const state = memorySharedState();
    const owner = vi.fn<() => Promise<string>>(() => later(1000, "result"));
    const waiter = vi.fn<() => Promise<string>>(() => later(0, "own"));
    const both = Promise.all([
      sharedSingleFlight(state)("key", owner),
      sharedSingleFlight(state)("key", waiter),
    ]);

    await vi.advanceTimersByTimeAsync(1250);

    expect(await both).toEqual(["result", "result"]);
    expect(waiter).not.toHaveBeenCalled();
  });

  it("runs itself after waiting 8 seconds for an owner that crashed and publishes its result", async () => {
    const state = memorySharedState();
    const run = vi.fn<() => Promise<string>>(() => later(0, "own"));

    await state.setIfAbsent("flight:key", "crashed-owner", 30);

    const waiting = sharedSingleFlight(state)("key", run);

    await vi.advanceTimersByTimeAsync(7999);

    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(251);

    expect(await waiting).toBe("own");
    expect(run).toHaveBeenCalledTimes(1);
    expect(await state.get("flight-result:key")).toBe("own");

    const third = vi.fn<() => Promise<string>>(() => later(0, "third"));

    expect(await sharedSingleFlight(state)("key", third)).toBe("own");
    expect(third).not.toHaveBeenCalled();
  });

  it("deletes its lock when its job fails so the next caller runs at once", async () => {
    const state = memorySharedState();
    const failing = vi.fn<() => Promise<string>>(async () => {
      throw new Error("Download failed");
    });
    const next = vi.fn<() => Promise<string>>(() => later(0, "next"));

    await expect(sharedSingleFlight(state)("key", failing)).rejects.toThrow("Download failed");

    expect(await state.get("flight:key")).toBeUndefined();

    const answer = sharedSingleFlight(state)("key", next);

    await vi.advanceTimersByTimeAsync(0);

    expect(await answer).toBe("next");
  });

  it("leaves a lock it does not own when its job fails", async () => {
    const state = memorySharedState();
    const failing = vi.fn<() => Promise<string>>(async () => {
      throw new Error("Download failed");
    });

    await state.setIfAbsent("flight:key", "other-owner", 30);

    const waiting = sharedSingleFlight(state)("key", failing).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(8250);

    expect(await waiting).toEqual(new Error("Download failed"));

    expect(await state.get("flight:key")).toBe("other-owner");
  });
});
