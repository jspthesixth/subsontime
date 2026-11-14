import type { Context } from "hono";
import * as v from "valibot";
import { TimingsInputError, lookUp, type WriteContext } from "./api.ts";
import type { TimingsStore } from "./db.ts";
import { submitterOf } from "./submitter.ts";

type WriteHandler = (store: TimingsStore, input: unknown, context: WriteContext) => Promise<void>;

type WriteDeps = {
  store: TimingsStore;
  installSalt: string;
  allow: (key: string) => boolean;
  clientKey: (context: Context) => string;
  originOf: (clientKey: string) => string;
};

const videoParamMessage = "Send video as a 16-character hex hash and a size in bytes";
const tooManyWritesMessage = "Too many submissions. Try again in an hour.";
const goneMessage = "This fix is no longer listed";
const videoParam = /^([0-9a-f]{16}):([1-9]\d{0,15})$/;
const installIdSchema = v.object({ installId: v.string() });

const inputErrorResponse = (context: Context, error: unknown) => {
  if (error instanceof TimingsInputError) {
    return context.json({ error: error.message }, 400);
  }

  throw error;
};

const videoOf = (param: string | undefined) => {
  const [, hash, size] = videoParam.exec(param ?? "") ?? [];

  return hash === undefined || size === undefined ? undefined : { hash, size: Number(size) };
};

export const lookUpRoute = (store: TimingsStore) => async (context: Context) => {
  const video = videoOf(context.req.query("video"));

  if (video === undefined) {
    return context.json({ error: videoParamMessage }, 400);
  }

  try {
    const timings = await lookUp(store, video);

    context.header("cache-control", "public, max-age=300");

    return context.json(timings);
  } catch (error) {
    return inputErrorResponse(context, error);
  }
};

export const cuesRoute = (store: TimingsStore) => async (context: Context) => {
  const video = videoOf(context.req.param("video"));

  if (video === undefined) {
    return context.json({ error: videoParamMessage }, 400);
  }

  try {
    const { fixes } = await lookUp(store, video, { withCues: true });
    const view = fixes.find((candidate) => candidate.id === context.req.param("id"));

    if (view === undefined) {
      return context.json({ error: goneMessage }, 404);
    }

    context.header("cache-control", "public, max-age=300");

    return context.json({ cues: view.cues });
  } catch (error) {
    return inputErrorResponse(context, error);
  }
};

export const writeRoute =
  (handler: WriteHandler, { store, installSalt, allow, clientKey, originOf }: WriteDeps) =>
  async (context: Context) => {
    const client = clientKey(context);

    if (!allow(client)) {
      return context.json({ error: tooManyWritesMessage }, 429);
    }

    const body: unknown = await context.req.json().catch(() => undefined);

    try {
      const installId = v.is(installIdSchema, body) ? body.installId : "";

      await handler(store, body, {
        submitter: submitterOf(installId, installSalt),
        origin: originOf(client),
      });
    } catch (error) {
      return inputErrorResponse(context, error);
    }

    return context.json({ ok: true }, 202);
  };
