import type { Context } from "hono";
import * as v from "valibot";
import { TimingsInputError, lookUp } from "./api.ts";
import type { TimingsStore } from "./db.ts";
import { submitterOf } from "./submitter.ts";

type WriteHandler = (
  store: TimingsStore,
  input: unknown,
  context: { submitter: string },
) => Promise<void>;

type WriteDeps = {
  store: TimingsStore;
  installSalt: string;
  allow: (key: string) => boolean;
  clientKey: (context: Context) => string;
};

const videoParamMessage = "Send video as a 16-character hex hash and a size in bytes";
const tooManyWritesMessage = "Too many submissions. Try again in an hour.";
const videoParam = /^([0-9a-f]{16}):(\d{1,16})$/;
const installIdSchema = v.object({ installId: v.string() });

const inputErrorResponse = (context: Context, error: unknown) => {
  if (error instanceof TimingsInputError) {
    return context.json({ error: error.message }, 400);
  }

  throw error;
};

export const lookUpRoute = (store: TimingsStore) => async (context: Context) => {
  const [, hash, size] = videoParam.exec(context.req.query("video") ?? "") ?? [];

  if (hash === undefined || size === undefined) {
    return context.json({ error: videoParamMessage }, 400);
  }

  try {
    const timings = await lookUp(store, { hash, size: Number(size) });

    context.header("cache-control", "public, max-age=300");

    return context.json(timings);
  } catch (error) {
    return inputErrorResponse(context, error);
  }
};

export const writeRoute =
  (handler: WriteHandler, { store, installSalt, allow, clientKey }: WriteDeps) =>
  async (context: Context) => {
    if (!allow(clientKey(context))) {
      return context.json({ error: tooManyWritesMessage }, 429);
    }

    const body: unknown = await context.req.json().catch(() => undefined);

    try {
      const installId = v.is(installIdSchema, body) ? body.installId : "";

      await handler(store, body, { submitter: submitterOf(installId, installSalt) });
    } catch (error) {
      return inputErrorResponse(context, error);
    }

    return context.json({ ok: true }, 202);
  };
