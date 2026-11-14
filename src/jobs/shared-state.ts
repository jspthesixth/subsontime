import { Redis } from "@upstash/redis";

export interface SharedState {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  delete(key: string): Promise<void>;
  increment(key: string, ttlSeconds: number): Promise<number>;
  decrement(key: string): Promise<number>;
}

type Entry = { value: string; expiresAt: number };

class SharedStatePaused extends Error {
  override name = "SharedStatePaused";
}

const keyPrefix = "sot:v1:";
const requestTimeoutMs = 2000;
const pauseMs = 10_000;
const incrementScript = `local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return count`;
const decrementScript = `if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end
local count = redis.call("DECR", KEYS[1])
if count <= 0 then redis.call("DEL", KEYS[1]) return 0 end
return count`;

export const orMiss = async <T>(work: () => Promise<T>, miss: T): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    console.error(`Shared state failed: ${error instanceof Error ? error.name : "unknown"}`);

    return miss;
  }
};

export const memorySharedState = (now = () => Date.now(), maxKeys = 10_000) => {
  const entries = new Map<string, Entry>();

  const live = (key: string) => {
    const entry = entries.get(key);

    if (entry !== undefined && entry.expiresAt <= now()) {
      entries.delete(key);

      return undefined;
    }

    return entry;
  };

  const put = (key: string, value: string, ttlSeconds: number) => {
    if (entries.size >= maxKeys) {
      [...entries.keys()].forEach(live);
    }

    entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
  };

  const add = (key: string, entry: Entry, change: number) => {
    const count = Math.max(Number(entry.value) + change, 0);

    entry.value = String(count);

    if (count === 0) {
      entries.delete(key);
    }

    return count;
  };

  return {
    keyCount: () => entries.size,
    async get(key: string) {
      return live(key)?.value;
    },
    async set(key: string, value: string, ttlSeconds: number) {
      put(key, value, ttlSeconds);
    },
    async setIfAbsent(key: string, value: string, ttlSeconds: number) {
      if (live(key) !== undefined) {
        return false;
      }

      put(key, value, ttlSeconds);

      return true;
    },
    async delete(key: string) {
      entries.delete(key);
    },
    async increment(key: string, ttlSeconds: number) {
      const entry = live(key);

      if (entry === undefined) {
        put(key, "1", ttlSeconds);

        return 1;
      }

      return add(key, entry, 1);
    },
    async decrement(key: string) {
      const entry = live(key);

      return entry === undefined ? 0 : add(key, entry, -1);
    },
  } satisfies SharedState & { keyCount: () => number };
};

export const upstashSharedState = (redis: Redis): SharedState => ({
  async get(key) {
    return (await redis.get<string>(keyPrefix + key)) ?? undefined;
  },
  async set(key, value, ttlSeconds) {
    await redis.set(keyPrefix + key, value, { ex: ttlSeconds });
  },
  async setIfAbsent(key, value, ttlSeconds) {
    return (await redis.set(keyPrefix + key, value, { nx: true, ex: ttlSeconds })) === "OK";
  },
  async delete(key) {
    await redis.del(keyPrefix + key);
  },
  async increment(key, ttlSeconds) {
    return Number(await redis.eval(incrementScript, [keyPrefix + key], [ttlSeconds]));
  },
  async decrement(key) {
    return Number(await redis.eval(decrementScript, [keyPrefix + key], []));
  },
});

export const pausedAfterFailure = (state: SharedState, now = () => Date.now()): SharedState => {
  let pausedUntil = 0;

  const call = async <T>(work: () => Promise<T>) => {
    if (now() < pausedUntil) {
      throw new SharedStatePaused("Shared state paused");
    }

    try {
      return await work();
    } catch (error) {
      pausedUntil = now() + pauseMs;

      throw error;
    }
  };

  return {
    get: (key) => call(() => state.get(key)),
    set: (key, value, ttlSeconds) => call(() => state.set(key, value, ttlSeconds)),
    setIfAbsent: (key, value, ttlSeconds) => call(() => state.setIfAbsent(key, value, ttlSeconds)),
    delete: (key) => call(() => state.delete(key)),
    increment: (key, ttlSeconds) => call(() => state.increment(key, ttlSeconds)),
    decrement: (key) => call(() => state.decrement(key)),
  };
};

export const sharedStateFrom = (env: NodeJS.ProcessEnv) => {
  const url = env["UPSTASH_REDIS_REST_URL"];
  const token = env["UPSTASH_REDIS_REST_TOKEN"];

  return url && token
    ? pausedAfterFailure(
        upstashSharedState(
          new Redis({
            url,
            token,
            automaticDeserialization: false,
            enableTelemetry: false,
            retry: false,
            signal: () => AbortSignal.timeout(requestTimeoutMs),
          }),
        ),
      )
    : undefined;
};
