import { createHash, createHmac } from "node:crypto";
import type { SharedState } from "../jobs/shared-state.ts";

export const limitKeyOf =
  (secret: string, now = () => Date.now()) =>
  (clientKey: string) => {
    const day = new Date(now()).toISOString().slice(0, 10);
    const dayKey = createHash("sha256").update(`limits:${secret}:${day}`).digest();

    return createHmac("sha256", dayKey).update(clientKey).digest("hex").slice(0, 16);
  };

export const rateLimit =
  (
    state: SharedState,
    keyOf: (clientKey: string) => string,
    name: string,
    limit: number,
    windowMs: number,
    now = () => Date.now(),
  ) =>
  async (clientKey: string) => {
    const windowStart = Math.floor(now() / windowMs) * windowMs;
    const count = await state.increment(
      `rl:${name}:${keyOf(clientKey)}:${windowStart}`,
      Math.ceil(windowMs / 1000),
    );

    return count <= limit;
  };
