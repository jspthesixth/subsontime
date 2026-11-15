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

  it("skips a value over 512 KB", async () => {
    const { state } = make();
    const largest = "x".repeat(512 * 1024);
    const tooLarge = `${largest}x`;

    await state.set(key("largest"), largest, 60);
    await state.set(key("too-large"), tooLarge, 60);

    expect(await state.setIfAbsent(key("too-large-lock"), tooLarge, 60)).toBe(false);
    expect((await state.get(key("largest")))?.length).toBe(largest.length);
    expect(await state.get(key("too-large"))).toBeUndefined();
    expect(await state.get(key("too-large-lock"))).toBeUndefined();
  });

  it("deletes a key only while it holds the given value", async () => {
    const { state } = make();

    await state.set(key("owned"), "mine", 60);

    expect(await state.deleteIfEquals(key("owned"), "theirs")).toBe(false);
    expect(await state.get(key("owned"))).toBe("mine");
    expect(await state.deleteIfEquals(key("owned"), "mine")).toBe(true);
    expect(await state.get(key("owned"))).toBeUndefined();
    expect(await state.deleteIfEquals(key("owned"), "mine")).toBe(false);
  });

  it("extends a key only while it holds the given value", async () => {
    const { state, pass } = make();

    await state.set(key("held"), "mine", 1);
    await state.set(key("other"), "theirs", 1);

    expect(await state.expireIfEquals(key("held"), "mine", 60)).toBe(true);
    expect(await state.expireIfEquals(key("other"), "mine", 60)).toBe(false);
    expect(await state.expireIfEquals(key("missing"), "mine", 60)).toBe(false);

    await pass(1.5);

    expect(await state.get(key("held"))).toBe("mine");
    expect(await state.get(key("other"))).toBeUndefined();
    expect(await state.get(key("missing"))).toBeUndefined();
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

  it("drops expired keys first once it holds the cap", async () => {
    let now = 0;
    const state = memorySharedState(() => now, 2);

    await state.set("a", "value", 1);
    await state.set("b", "value", 60);

    now = 2000;
    await state.set("c", "value", 60);

    expect(state.keyCount()).toBe(2);
    expect([await state.get("b"), await state.get("c")]).toEqual(["value", "value"]);
  });

  it("drops the oldest key once it holds the cap and none has expired", async () => {
    const state = memorySharedState(() => 0, 2);

    await state.set("a", "value", 60);
    await state.set("b", "value", 60);
    await state.set("a", "rewritten", 60);
    await state.set("c", "value", 60);

    expect(state.keyCount()).toBe(2);
    expect([await state.get("b"), await state.get("a"), await state.get("c")]).toEqual([
      undefined,
      "rewritten",
      "value",
    ]);
  });

  it("holds at most 50 000 keys by default", async () => {
    const state = memorySharedState(() => 0);

    for (const index of Array.from({ length: 50_001 }, (_, each) => each)) {
      await state.increment(`key-${index}`, 60);
    }

    expect(state.keyCount()).toBe(50_000);
    expect(await state.get("key-0")).toBeUndefined();
    expect(await state.get("key-50000")).toBe("1");
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
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue("value");
    const paused = pausedAfterFailure(state, () => now);

    await expect(paused.get("key")).rejects.toThrow("fetch failed");

    now = 9999;

    await expect(paused.increment("key", 60)).rejects.toThrow("Shared state paused");
    await expect(paused.get("key")).rejects.toThrow("Shared state paused");

    now = 10_000;

    expect(await paused.get("key")).toBe("value");
    expect(get).toHaveBeenCalledTimes(2);
  });
});

const named = (name: string) => Object.assign(new Error("failed"), { name });

describe("pausedAfterFailure on each kind of failure", () => {
  it.each([
    ["a timeout", named("TimeoutError"), true],
    ["an abort", named("AbortError"), true],
    ["a failed fetch", new TypeError("fetch failed"), true],
    ["a refused connection", new Error("failed", { cause: { code: "ECONNREFUSED" } }), true],
    ["a reset connection", Object.assign(new Error("failed"), { code: "ECONNRESET" }), true],
    ["a command error", named("UpstashError"), false],
    ["any other error", new Error("Value too large"), false],
  ])("after %s pauses: %s", async (_, error, pauses) => {
    const state = memorySharedState();

    vi.spyOn(state, "get").mockRejectedValueOnce(error).mockResolvedValue("value");

    const paused = pausedAfterFailure(state, () => 0);

    await expect(paused.get("key")).rejects.toBe(error);

    const next = await paused.get("key").catch((failure: unknown) => failure);

    expect(next instanceof Error && next.name === "SharedStatePaused").toBe(pauses);
  });
});

describe("sharedStateFrom", () => {
  it("is undefined without both Upstash variables", () => {
    expect(sharedStateFrom({})).toBeUndefined();
    expect(sharedStateFrom({ UPSTASH_REDIS_REST_URL: "http://localhost:8079" })).toBeUndefined();
    expect(sharedStateFrom({ UPSTASH_REDIS_REST_TOKEN: "token" })).toBeUndefined();
  });

  it("connects with the Upstash variables", () => {
    expect(
      sharedStateFrom({
        UPSTASH_REDIS_REST_URL: "http://localhost:8079",
        UPSTASH_REDIS_REST_TOKEN: "token",
      }),
    ).toBeDefined();
  });

  it("connects with the Vercel KV variables", () => {
    expect(
      sharedStateFrom({ KV_REST_API_URL: "http://localhost:8079", KV_REST_API_TOKEN: "token" }),
    ).toBeDefined();
  });
});

describe("orMiss", () => {
  it("logs nothing while the shared state is paused", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = memorySharedState();

    vi.spyOn(state, "get").mockRejectedValue(new TypeError("fetch failed"));

    const paused = pausedAfterFailure(state, () => 0);

    try {
      await orMiss(() => paused.get("key"), undefined);
      await orMiss(() => paused.get("key"), undefined);

      expect(log.mock.calls).toEqual([["Shared state failed: TypeError"]]);
    } finally {
      log.mockRestore();
    }
  });

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
