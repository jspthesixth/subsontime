import { createHmac, randomBytes } from "node:crypto";
import type { SharedState } from "../jobs/shared-state.ts";

const keySeconds = 26 * 60 * 60;
const rereadMs = 10 * 60 * 1000;

const dailyKey = async (state: SharedState, day: string, readAt: number) => {
  const key = `origin-key:${day}`;

  await state.setIfAbsent(key, randomBytes(32).toString("base64"), keySeconds);

  const secret = await state.get(key);

  if (secret === undefined) {
    throw new Error("The daily origin key is missing");
  }

  return { day, secret: Buffer.from(secret, "base64"), readAt };
};

export const dailyOrigins = (state: SharedState, now = () => Date.now()) => {
  let current: { day: string; secret: Buffer; readAt: number } | undefined;

  return async (clientKey: string): Promise<string> => {
    const time = now();
    const day = new Date(time).toISOString().slice(0, 10);

    if (current?.day !== day || time - current.readAt >= rereadMs) {
      current = await dailyKey(state, day, time);
    }

    return createHmac("sha256", current.secret).update(clientKey).digest("hex").slice(0, 16);
  };
};
