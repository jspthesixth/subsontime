import { describe, expect, it, vi } from "vitest";
import { memorySharedState, type SharedState } from "../jobs/shared-state.ts";
import { installKeyOf, tokenCacheFor } from "./token-cache.ts";

const installA = installKeyOf("A".repeat(48));
const installB = installKeyOf("B".repeat(48));
const secret = "a-test-secret-that-is-long-enough-1234";
const token = JSON.stringify({ token: "session-token-123" });

const recorded = () => {
  const state = memorySharedState();
  const set = vi.spyOn(state, "set");

  return { state, written: () => set.mock.calls.map(([key, value]) => ({ key, value })) };
};

const failing = async (): Promise<never> => {
  throw new Error("Redis is down");
};

const brokenState: SharedState = {
  get: failing,
  set: failing,
  setIfAbsent: failing,
  delete: failing,
  increment: failing,
  deleteIfEquals: failing,
  expireIfEquals: failing,
};

describe("tokenCacheFor", () => {
  it("reads back a token it stored", async () => {
    const cache = tokenCacheFor(memorySharedState(), secret, installA);

    await cache.set("alice", token, 60);

    expect(await cache.get("alice")).toBe(token);
    expect(await cache.get("bob")).toBeUndefined();
  });

  it("stores neither the token nor the source key in the clear", async () => {
    const { state, written } = recorded();

    await tokenCacheFor(state, secret, installA).set("alice", token, 60);

    expect(written()).toHaveLength(1);
    expect(written()[0]?.key).toMatch(/^tok:[0-9a-f]{64}$/);
    expect(written()[0]?.value).not.toContain("session-token-123");
  });

  it("keeps the tokens of two installs apart", async () => {
    const state = memorySharedState();

    await tokenCacheFor(state, secret, installA).set("alice", token, 60);

    expect(await tokenCacheFor(state, secret, installB).get("alice")).toBeUndefined();
  });

  it("cannot decrypt a token stored for another install key", async () => {
    const { state, written } = recorded();
    const other = tokenCacheFor(state, secret, installB);

    await tokenCacheFor(state, secret, installA).set("alice", token, 60);
    await other.set("alice", "placeholder", 60);

    const [stolen, target] = written();

    await state.set(target?.key ?? "", stolen?.value ?? "", 60);

    expect(await other.get("alice")).toBeUndefined();
  });

  it("cannot decrypt a token stored under another server secret", async () => {
    const state = memorySharedState();

    await tokenCacheFor(state, secret, installA).set("alice", token, 60);

    expect(
      await tokenCacheFor(state, "another-secret-that-is-long-enough-12345", installA).get("alice"),
    ).toBeUndefined();
    expect(await tokenCacheFor(state, secret, installA).get("alice")).toBe(token);
  });

  it("treats a malformed stored value as a miss", async () => {
    const { state, written } = recorded();
    const cache = tokenCacheFor(state, secret, installA);

    await cache.set("alice", token, 60);
    await state.set(written()[0]?.key ?? "", "not a sealed token", 60);

    expect(await cache.get("alice")).toBeUndefined();
  });

  it("treats shared state errors as a miss", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cache = tokenCacheFor(brokenState, secret, installA);

    try {
      await expect(cache.set("alice", token, 60)).resolves.toBeUndefined();
      expect(await cache.get("alice")).toBeUndefined();
    } finally {
      error.mockRestore();
    }
  });
});
