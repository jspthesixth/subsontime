export const rateLimit = (limit: number, windowMs: number, now = Date.now) => {
  const hits = new Map<string, number[]>();

  return (key: string) => {
    const time = now();
    const recent = (hits.get(key) ?? []).filter((hit) => hit > time - windowMs);
    const allowed = recent.length < limit;

    hits.set(key, allowed ? [...recent, time] : recent);

    return allowed;
  };
};
