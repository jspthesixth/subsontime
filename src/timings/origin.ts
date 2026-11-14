import { createHmac, randomBytes } from "node:crypto";
import type { SharedState } from "../jobs/shared-state.ts";

const keySeconds = 26 * 60 * 60;

export const dailyOrigins =
  (state: SharedState, now = () => Date.now()) =>
  async (clientKey: string): Promise<string> => {
    const key = `origin-key:${new Date(now()).toISOString().slice(0, 10)}`;

    await state.setIfAbsent(key, randomBytes(32).toString("base64"), keySeconds);

    const secret = await state.get(key);

    if (secret === undefined) {
      throw new Error("The daily origin key is missing");
    }

    return createHmac("sha256", Buffer.from(secret, "base64"))
      .update(clientKey)
      .digest("hex")
      .slice(0, 16);
  };
