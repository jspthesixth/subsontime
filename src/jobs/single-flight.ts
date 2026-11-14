const jobs = new Map<string, Promise<unknown>>();

export const singleFlight = <T>(key: string, run: () => Promise<T>): Promise<T> => {
  const running = jobs.get(key) as Promise<T> | undefined;

  if (running !== undefined) {
    return running;
  }

  const job = run().finally(() => jobs.delete(key));

  jobs.set(key, job);

  return job;
};
