import { createHmac, randomBytes } from "node:crypto";

const dailyKey = (day: string) => ({ day, key: randomBytes(32) });

export const dailyOrigins = (now = Date.now) => {
  let current = dailyKey("");

  return (clientKey: string): string => {
    const day = new Date(now()).toISOString().slice(0, 10);

    if (current.day !== day) {
      current = dailyKey(day);
    }

    return createHmac("sha256", current.key).update(clientKey).digest("hex").slice(0, 16);
  };
};
