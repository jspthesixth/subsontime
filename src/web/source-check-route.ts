import type { Context } from "hono";
import * as v from "valibot";
import { sourceSchema, type SourceSettings } from "../config/config.ts";
import { checkSubDL } from "../sources/subdl.ts";
import { checkSubSource } from "../sources/subsource.ts";
import { checkTitlovi } from "../sources/titlovi.ts";

type Checkable = Extract<SourceSettings, { kind: "titlovi" | "subdl" | "subsource" }>;

const checkTimeoutMs = 8000;
const uncheckableMessage = "This source cannot be checked";
const tooManyMessage = "Too many checks. Try again in a minute.";

const labels: Record<Checkable["kind"], { name: string; secret: string }> = {
  titlovi: { name: "Titlovi.com", secret: "username and password" },
  subdl: { name: "SubDL", secret: "API key" },
  subsource: { name: "SubSource", secret: "API key" },
};

const isCheckable = (source: SourceSettings): source is Checkable => source.kind in labels;

const runCheck = (source: Checkable) => {
  switch (source.kind) {
    case "titlovi":
      return checkTitlovi(source, checkTimeoutMs);
    case "subdl":
      return checkSubDL(source.apiKey, checkTimeoutMs);
    case "subsource":
      return checkSubSource(source.apiKey, checkTimeoutMs);
  }
};

const clientKey = (context: Context) =>
  context.req.header("x-real-ip") ??
  context.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
  "unknown";

export const sourceCheckRoute = (allow: (key: string) => boolean) => async (context: Context) => {
  context.header("Cache-Control", "no-store");

  if (!allow(clientKey(context))) {
    return context.json({ error: tooManyMessage }, 429);
  }

  const body = v.safeParse(sourceSchema, await context.req.json().catch(() => undefined), {
    message: uncheckableMessage,
  });

  if (!body.success || !isCheckable(body.output)) {
    return context.json({ error: body.success ? uncheckableMessage : body.issues[0].message }, 400);
  }

  const { name, secret } = labels[body.output.kind];
  const accepted = await runCheck(body.output).catch(() => undefined);

  if (accepted === undefined) {
    return context.json({ ok: false, error: `Could not reach ${name}. Try again.` });
  }

  return context.json(
    accepted ? { ok: true } : { ok: false, error: `${name} did not accept this ${secret}.` },
  );
};
