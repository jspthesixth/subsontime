import { expect, test, vi } from "vitest";
import { memorySharedState } from "../jobs/shared-state.ts";
import { dailyOrigins } from "./origin.ts";

const day = Date.UTC(2026, 10, 14, 12);
const dayMs = 86_400_000;

test("dailyOrigins is 16 hex characters and stable for one client within a UTC day", async () => {
  let now = day;
  const originOf = dailyOrigins(memorySharedState(), () => now);
  const morning = await originOf("1.2.3.4");

  now = day + 11 * 3_600_000;

  expect(morning).toMatch(/^[0-9a-f]{16}$/);
  expect(await originOf("1.2.3.4")).toBe(morning);
});

test("dailyOrigins tells two clients apart", async () => {
  const originOf = dailyOrigins(memorySharedState(), () => day);

  expect(await originOf("1.2.3.4")).not.toBe(await originOf("5.6.7.8"));
});

test("dailyOrigins changes the key on a new UTC day", async () => {
  let now = day;
  const originOf = dailyOrigins(memorySharedState(), () => now);
  const today = await originOf("1.2.3.4");
  const otherToday = await originOf("5.6.7.8");

  now = day + dayMs;

  expect(await originOf("1.2.3.4")).not.toBe(today);
  expect(await originOf("5.6.7.8")).not.toBe(otherToday);
  expect(await originOf("5.6.7.8")).not.toBe(today);
});

test("dailyOrigins agrees between two instances on one state for a day", async () => {
  let now = day;
  const state = memorySharedState();
  const one = dailyOrigins(state, () => now);
  const two = dailyOrigins(state, () => now);
  const [first, second] = await Promise.all([one("1.2.3.4"), two("1.2.3.4")]);

  expect(first).toBe(second);

  now = day + dayMs;

  expect(await two("1.2.3.4")).not.toBe(first);
  expect(await one("1.2.3.4")).toBe(await two("1.2.3.4"));
});

test("dailyOrigins uses a different key on another state", async () => {
  const origin = dailyOrigins(memorySharedState(), () => day);
  const other = dailyOrigins(memorySharedState(), () => day);

  expect(await origin("1.2.3.4")).not.toBe(await other("1.2.3.4"));
});

test("dailyOrigins rejects when the shared state fails", async () => {
  const state = memorySharedState();
  const originOf = dailyOrigins(
    {
      ...state,
      get: async () => {
        throw new Error("Redis is down");
      },
    },
    () => day,
  );

  await expect(originOf("1.2.3.4")).rejects.toThrow("Redis is down");
});

test("dailyOrigins reads the daily key from the state once a day", async () => {
  let now = day;
  const state = memorySharedState();
  const get = vi.spyOn(state, "get");
  const originOf = dailyOrigins(state, () => now);

  await originOf("1.2.3.4");
  await originOf("5.6.7.8");

  expect(get).toHaveBeenCalledTimes(1);

  now = day + dayMs;
  await originOf("1.2.3.4");

  expect(get).toHaveBeenCalledTimes(2);
});
