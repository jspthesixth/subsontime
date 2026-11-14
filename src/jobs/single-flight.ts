import { randomUUID } from "node:crypto";
import { orMiss, type SharedState } from "./shared-state.ts";

export type SingleFlight = (key: string, run: () => Promise<string>) => Promise<string>;

const lockSeconds = 30;
const resultSeconds = 60;
const pollMs = 250;
const waitMs = 8000;

export const memorySingleFlight = () => {
  const jobs = new Map<string, Promise<unknown>>();

  return <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const running = jobs.get(key) as Promise<T> | undefined;

    if (running !== undefined) {
      return running;
    }

    const job = run().finally(() => jobs.delete(key));

    jobs.set(key, job);

    return job;
  };
};

const pause = () => new Promise((resolve) => setTimeout(resolve, pollMs));

const awaitResult = async (
  state: SharedState,
  key: string,
  deadline: number,
): Promise<string | undefined> => {
  const result = await orMiss(() => state.get(key), undefined);

  if (result !== undefined || Date.now() >= deadline) {
    return result;
  }

  await pause();

  return awaitResult(state, key, deadline);
};

const acrossInstances = async (state: SharedState, key: string, run: () => Promise<string>) => {
  const lockKey = `flight:${key}`;
  const resultKey = `flight-result:${key}`;
  const owner = randomUUID();
  const owns = await orMiss(() => state.setIfAbsent(lockKey, owner, lockSeconds), true);
  const waited = owns ? undefined : await awaitResult(state, resultKey, Date.now() + waitMs);

  if (waited !== undefined) {
    return waited;
  }

  try {
    const result = await run();

    await orMiss(() => state.set(resultKey, result, resultSeconds), undefined);

    return result;
  } catch (error) {
    if (owns) {
      await orMiss(() => state.deleteIfEquals(lockKey, owner), false);
    }

    throw error;
  }
};

export const sharedSingleFlight = (state: SharedState): SingleFlight => {
  const local = memorySingleFlight();

  return (key, run) => local(key, () => acrossInstances(state, key, run));
};
