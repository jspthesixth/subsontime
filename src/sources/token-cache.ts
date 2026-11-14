export interface TokenCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, token: string, ttlSeconds: number): Promise<void>;
}

export const memoryTokenCache = (): TokenCache => {
  const entries = new Map<string, { token: string; expiresAt: number }>();

  return {
    async get(key) {
      const entry = entries.get(key);

      if (entry === undefined || entry.expiresAt <= Date.now()) {
        entries.delete(key);

        return undefined;
      }

      return entry.token;
    },
    async set(key, token, ttlSeconds) {
      entries.set(key, { token, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
  };
};
