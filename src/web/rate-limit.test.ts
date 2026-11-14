import { describe, expect, it } from "vitest";
import { memorySharedState } from "../jobs/shared-state.ts";
import { rateLimit } from "./rate-limit.ts";

const hits = async (allow: (key: string) => Promise<boolean>, key: string, count: number) => {
  const answers: boolean[] = [];

  for (const _ of Array.from({ length: count })) {
    answers.push(await allow(key));
  }

  return answers;
};

describe("rateLimit", () => {
  it("allows the limit in a window and again in the next window", async () => {
    let time = 0;
    const allow = rateLimit(
      memorySharedState(() => time),
      "test",
      2,
      60_000,
      () => time,
    );

    expect(await hits(allow, "a", 3)).toEqual([true, true, false]);

    time = 60_000;

    expect(await allow("a")).toBe(true);
  });

  it("keeps a separate count for each key and each limiter", async () => {
    const state = memorySharedState();
    const first = rateLimit(state, "first", 1, 60_000);
    const second = rateLimit(state, "second", 1, 60_000);

    expect([await first("a"), await first("b"), await first("a"), await second("a")]).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });

  it("shares one count between two instances on one state", async () => {
    const state = memorySharedState();
    const one = rateLimit(state, "shared", 3, 60_000);
    const two = rateLimit(state, "shared", 3, 60_000);

    expect([...(await hits(one, "a", 2)), ...(await hits(two, "a", 2))]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("rejects when the shared state fails", async () => {
    const state = memorySharedState();
    const allow = rateLimit(
      {
        ...state,
        increment: async () => {
          throw new Error("Redis is down");
        },
      },
      "broken",
      1,
      60_000,
    );

    await expect(allow("a")).rejects.toThrow("Redis is down");
  });
});
