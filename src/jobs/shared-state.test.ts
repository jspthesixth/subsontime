import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Redis } from "@upstash/redis";
import { describe, expect, it, vi } from "vitest";
import {
  memorySharedState,
  orMiss,
  pausedAfterFailure,
  sharedStateFrom,
  type SharedState,
} from "./shared-state.ts";

type Subject = { state: SharedState; pass: (seconds: number) => Promise<void> };

const upstashURL = process.env["UPSTASH_REDIS_REST_URL"];
const upstashToken = process.env["UPSTASH_REDIS_REST_TOKEN"];

const memorySubject = (): Subject => {
  let now = 0;

  return {
    state: memorySharedState(() => now),
    pass: async (seconds) => {
      now += seconds * 1000;
    },
  };
};

const upstashSubject = (): Subject => {
  const state = sharedStateFrom(process.env);

  if (state === undefined) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set");
  }

  return { state, pass: (seconds) => sleep(seconds * 1000) };
};

const contract = (make: () => Subject) => {
  const run = randomUUID();
  const key = (name: string) => `test:${run}:${name}`;

  it("answers undefined for a missing key", async () => {
    expect(await make().state.get(key("missing"))).toBeUndefined();
  });

  it("keeps every value as the exact string it was given", async () => {
    const { state } = make();
    const values = [
      "123",
      '{"a":1}',
      "true",
      "null",
      "",
      "plain text",
      "1\n00:00:01,000 --> 00:00:02,000\nČaša mleka, ŝi diris: «Ça va?» 字幕\n",
    ];

    await Promise.all(values.map((value, index) => state.set(key(`exact-${index}`), value, 60)));

    expect(await Promise.all(values.map((_, index) => state.get(key(`exact-${index}`))))).toEqual(
      values,
    );
  });

  it("forgets a value once its time to live has passed", async () => {
    const { state, pass } = make();

    await state.set(key("expiring"), "value", 1);

    expect(await state.get(key("expiring"))).toBe("value");

    await pass(1.5);

    expect(await state.get(key("expiring"))).toBeUndefined();
  });

  it("sets a value only when the key is absent", async () => {
    const { state, pass } = make();

    expect(await state.setIfAbsent(key("lock"), "first", 1)).toBe(true);
    expect(await state.setIfAbsent(key("lock"), "second", 1)).toBe(false);
    expect(await state.get(key("lock"))).toBe("first");

    await pass(1.5);

    expect(await state.setIfAbsent(key("lock"), "third", 60)).toBe(true);
    expect(await state.get(key("lock"))).toBe("third");
  });

  it("deletes a key and ignores a missing one", async () => {
    const { state } = make();

    await state.set(key("deleted"), "value", 60);
    await state.delete(key("deleted"));
    await state.delete(key("never-set"));

    expect(await state.get(key("deleted"))).toBeUndefined();
  });

  it("counts up and expires the count a time to live after the first increment", async () => {
    const { state, pass } = make();

    expect(await state.increment(key("count"), 1)).toBe(1);

    await pass(0.6);

    expect(await state.increment(key("count"), 1)).toBe(2);
    expect(await state.get(key("count"))).toBe("2");

    await pass(0.9);

    expect(await state.increment(key("count"), 1)).toBe(1);
  });

  it("counts down to zero, removes the key there and never creates it", async () => {
    const { state } = make();

    await state.increment(key("slots"), 60);
    await state.increment(key("slots"), 60);

    expect(await state.decrement(key("slots"))).toBe(1);
    expect(await state.decrement(key("slots"))).toBe(0);
    expect(await state.get(key("slots"))).toBeUndefined();
    expect(await state.decrement(key("slots"))).toBe(0);
    expect(await state.get(key("slots"))).toBeUndefined();
  });

  it("increments once per call when calls race", async () => {
    const { state } = make();
    const counts = await Promise.all(
      Array.from({ length: 10 }, () => state.increment(key("race"), 60)),
    );

    expect(counts.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
};

describe("memorySharedState", () => {
  contract(memorySubject);

  it("drops expired keys once it holds too many", async () => {
    let now = 0;
    const state = memorySharedState(() => now, 2);

    await Promise.all(["a", "b", "c"].map((key) => state.set(key, "value", 1)));

    now = 2000;
    await state.set("d", "value", 1);

    expect(state.keyCount()).toBe(1);
  });
});

describe.skipIf(upstashURL === undefined || upstashToken === undefined)(
  "upstashSharedState (needs UPSTASH_REDIS_REST_URL, skipped when unset)",
  () => {
    contract(upstashSubject);

    it("prefixes every key with sot:v1:", async () => {
      const key = `test:${randomUUID()}:prefixed`;
      const raw = new Redis({
        url: upstashURL,
        token: upstashToken,
        automaticDeserialization: false,
      });

      await upstashSubject().state.set(key, "value", 60);

      expect(await raw.get(`sot:v1:${key}`)).toBe("value");
      expect(await raw.get(key)).toBeNull();
    });
  },
);

describe("pausedAfterFailure", () => {
  it("skips the shared state for ten seconds after a failure", async () => {
    let now = 0;
    const state = memorySharedState();
    const get = vi
      .spyOn(state, "get")
      .mockRejectedValueOnce(new Error("Redis is down"))
      .mockResolvedValue("value");
    const paused = pausedAfterFailure(state, () => now);

    await expect(paused.get("key")).rejects.toThrow("Redis is down");

    now = 9999;

    await expect(paused.increment("key", 60)).rejects.toThrow("Shared state paused");
    await expect(paused.get("key")).rejects.toThrow("Shared state paused");

    now = 10_000;

    expect(await paused.get("key")).toBe("value");
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("sharedStateFrom", () => {
  it("is undefined without both Upstash variables", () => {
    expect(sharedStateFrom({})).toBeUndefined();
    expect(sharedStateFrom({ UPSTASH_REDIS_REST_URL: "http://localhost:8079" })).toBeUndefined();
    expect(sharedStateFrom({ UPSTASH_REDIS_REST_TOKEN: "token" })).toBeUndefined();
  });
});

describe("orMiss", () => {
  it("answers the miss value and logs only the error name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const answer = await orMiss(async (): Promise<string> => {
        throw new TypeError("fetch failed for https://secret.example/token");
      }, "miss");

      expect(answer).toBe("miss");
      expect(log.mock.calls.flat().join(" ")).toContain("TypeError");
      expect(log.mock.calls.flat().join(" ")).not.toContain("secret");
    } finally {
      log.mockRestore();
    }
  });
});
