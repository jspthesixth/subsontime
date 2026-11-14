import { setTimeout as sleep } from "node:timers/promises";
import { orMiss, type SharedState } from "./shared-state.ts";

export type SingleFlight = (key: string, run: () => Promise<string>) => Promise<string>;

const lockSeconds = 30;
const resultSeconds = 60;
const pollMs = 100;
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

const awaitResult = async (state: SharedState, key: string, deadline: number) => {
  const result = await orMiss(() => state.get(key), undefined);

  if (result !== undefined || Date.now() >= deadline) {
    return result;
  }

  await sleep(pollMs);

  return awaitResult(state, key, deadline);
};

export const sharedSingleFlight =
  (state: SharedState): SingleFlight =>
  async (key, run) => {
    const resultKey = `flight-result:${key}`;
    const owner = await orMiss(() => state.setIfAbsent(`flight:${key}`, "1", lockSeconds), true);

    if (!owner) {
      return (await awaitResult(state, resultKey, Date.now() + waitMs)) ?? run();
    }

    const result = await run();

    await orMiss(() => state.set(resultKey, result, resultSeconds), undefined);

    return result;
  };
