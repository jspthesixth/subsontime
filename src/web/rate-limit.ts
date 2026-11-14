export const rateLimit = (limit: number, windowMs: number, now = Date.now, maxKeys = 10_000) => {
  const hits = new Map<string, number[]>();

  const recentHits = (key: string, time: number) =>
    (hits.get(key) ?? []).filter((hit) => hit > time - windowMs);

  const keep = (key: string, recent: number[]) => {
    if (recent.length === 0) {
      hits.delete(key);
    } else {
      hits.set(key, recent);
    }
  };

  const allow = (key: string) => {
    const time = now();

    if (hits.size > maxKeys) {
      [...hits.keys()].forEach((each) => keep(each, recentHits(each, time)));
    }

    const recent = recentHits(key, time);
    const allowed = recent.length < limit;

    keep(key, allowed ? [...recent, time] : recent);

    return allowed;
  };

  return { allow, keyCount: () => hits.size };
};
