import { expect, test } from "vitest";
import { dailyOrigins } from "./origin.ts";

const day = Date.UTC(2026, 10, 14, 12);
const dayMs = 86_400_000;

test("dailyOrigins is 16 hex characters and stable for one client within a UTC day", () => {
  let now = day;
  const originOf = dailyOrigins(() => now);
  const morning = originOf("1.2.3.4");

  now = day + 11 * 3_600_000;

  expect(morning).toMatch(/^[0-9a-f]{16}$/);
  expect(originOf("1.2.3.4")).toBe(morning);
});

test("dailyOrigins tells two clients apart", () => {
  const originOf = dailyOrigins(() => day);

  expect(originOf("1.2.3.4")).not.toBe(originOf("5.6.7.8"));
});

test("dailyOrigins changes the key on a new UTC day", () => {
  let now = day;
  const originOf = dailyOrigins(() => now);
  const today = originOf("1.2.3.4");
  const otherToday = originOf("5.6.7.8");

  now = day + dayMs;

  expect(originOf("1.2.3.4")).not.toBe(today);
  expect(originOf("5.6.7.8")).not.toBe(otherToday);
  expect(originOf("5.6.7.8")).not.toBe(today);
});

test("dailyOrigins uses a different key in another process", () => {
  expect(dailyOrigins(() => day)("1.2.3.4")).not.toBe(dailyOrigins(() => day)("1.2.3.4"));
});
