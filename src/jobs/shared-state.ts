import { Redis } from "@upstash/redis";

export interface SharedState {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  delete(key: string): Promise<void>;
  increment(key: string, ttlSeconds: number): Promise<number>;
  deleteIfEquals(key: string, value: string): Promise<boolean>;
  expireIfEquals(key: string, value: string, ttlSeconds: number): Promise<boolean>;
}

type Entry = { value: string; expiresAt: number };

class SharedStatePaused extends Error {
  override name = "SharedStatePaused";
}

const keyPrefix = "sot:v1:";
const requestTimeoutMs = 2000;
const pauseMs = 10_000;
const maximumValueBytes = 512 * 1024;
const transportErrorNames = new Set(["AbortError", "TimeoutError", "TypeError"]);
const incrementScript = `local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return count`;
const deleteIfEqualsScript = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0`;
const expireIfEqualsScript = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], ARGV[2]) end
return 0`;

const fits = (value: string) => Buffer.byteLength(value) <= maximumValueBytes;

const codeOf = (value: unknown) =>
  typeof value === "object" && value !== null && "code" in value ? String(value.code) : "";

const isTransportFailure = (error: unknown) =>
  error instanceof Error &&
  (transportErrorNames.has(error.name) ||
    [codeOf(error), codeOf(error.cause)].some((code) => code.startsWith("ECONN")));

export const orMiss = async <T>(work: () => Promise<T>, miss: T): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof SharedStatePaused)) {
      console.error(`Shared state failed: ${error instanceof Error ? error.name : "unknown"}`);
    }

    return miss;
  }
};

export const memorySharedState = (now = () => Date.now(), maxKeys = 50_000) => {
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
    entries.delete(key);

    if (entries.size >= maxKeys) {
      [...entries.keys()].forEach(live);
    }

    if (entries.size >= maxKeys) {
      entries.delete(entries.keys().next().value ?? "");
    }

    entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
  };

  return {
    keyCount: () => entries.size,
    async get(key: string) {
      return live(key)?.value;
    },
    async set(key: string, value: string, ttlSeconds: number) {
      if (fits(value)) {
        put(key, value, ttlSeconds);
      }
    },
    async setIfAbsent(key: string, value: string, ttlSeconds: number) {
      if (!fits(value) || live(key) !== undefined) {
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

      entry.value = String(Number(entry.value) + 1);

      return Number(entry.value);
    },
    async deleteIfEquals(key: string, value: string) {
      if (live(key)?.value !== value) {
        return false;
      }

      entries.delete(key);

      return true;
    },
    async expireIfEquals(key: string, value: string, ttlSeconds: number) {
      const entry = live(key);

      if (entry?.value !== value) {
        return false;
      }

      entry.expiresAt = now() + ttlSeconds * 1000;

      return true;
    },
  } satisfies SharedState & { keyCount: () => number };
};

export const upstashSharedState = (redis: Redis): SharedState => {
  const increment = redis.createScript(incrementScript);
  const deleteIfEquals = redis.createScript(deleteIfEqualsScript);
  const expireIfEquals = redis.createScript(expireIfEqualsScript);

  return {
    async get(key) {
      return (await redis.get<string>(keyPrefix + key)) ?? undefined;
    },
    async set(key, value, ttlSeconds) {
      if (fits(value)) {
        await redis.set(keyPrefix + key, value, { ex: ttlSeconds });
      }
    },
    async setIfAbsent(key, value, ttlSeconds) {
      return (
        fits(value) &&
        (await redis.set(keyPrefix + key, value, { nx: true, ex: ttlSeconds })) === "OK"
      );
    },
    async delete(key) {
      await redis.del(keyPrefix + key);
    },
    async increment(key, ttlSeconds) {
      return Number(await increment.exec([keyPrefix + key], [String(ttlSeconds)]));
    },
    async deleteIfEquals(key, value) {
      return Number(await deleteIfEquals.exec([keyPrefix + key], [value])) === 1;
    },
    async expireIfEquals(key, value, ttlSeconds) {
      return (
        Number(await expireIfEquals.exec([keyPrefix + key], [value, String(ttlSeconds)])) === 1
      );
    },
  };
};

export const pausedAfterFailure = (state: SharedState, now = () => Date.now()): SharedState => {
  let pausedUntil = 0;

  const call = async <T>(work: () => Promise<T>) => {
    if (now() < pausedUntil) {
      throw new SharedStatePaused("Shared state paused");
    }

    try {
      return await work();
    } catch (error) {
      if (isTransportFailure(error)) {
        pausedUntil = now() + pauseMs;
      }

      throw error;
    }
  };

  return {
    get: (key) => call(() => state.get(key)),
    set: (key, value, ttlSeconds) => call(() => state.set(key, value, ttlSeconds)),
    setIfAbsent: (key, value, ttlSeconds) => call(() => state.setIfAbsent(key, value, ttlSeconds)),
    delete: (key) => call(() => state.delete(key)),
    increment: (key, ttlSeconds) => call(() => state.increment(key, ttlSeconds)),
    deleteIfEquals: (key, value) => call(() => state.deleteIfEquals(key, value)),
    expireIfEquals: (key, value, ttlSeconds) =>
      call(() => state.expireIfEquals(key, value, ttlSeconds)),
  };
};

export const sharedStateFrom = (env: NodeJS.ProcessEnv) => {
  const url = env["UPSTASH_REDIS_REST_URL"] || env["KV_REST_API_URL"];
  const token = env["UPSTASH_REDIS_REST_TOKEN"] || env["KV_REST_API_TOKEN"];

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
