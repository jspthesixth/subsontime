import type { SharedState } from "../jobs/shared-state.ts";

export const rateLimit =
  (state: SharedState, name: string, limit: number, windowMs: number, now = () => Date.now()) =>
  async (clientKey: string) => {
    const windowStart = Math.floor(now() / windowMs) * windowMs;
    const count = await state.increment(
      `rl:${name}:${clientKey}:${windowStart}`,
      Math.ceil(windowMs / 1000),
    );

    return count <= limit;
  };
