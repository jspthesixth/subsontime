import type { Context } from "hono";
import * as v from "valibot";
import { sourceSchema, type SourceSettings } from "../config/config.ts";
import type { Verdict } from "../sources/check.ts";
import { checkSubDL } from "../sources/subdl.ts";
import { checkSubSource } from "../sources/subsource.ts";
import { checkTitlovi } from "../sources/titlovi.ts";

type Checkable = Extract<SourceSettings, { kind: "titlovi" | "subdl" | "subsource" }>;

type SourceCheckDeps = {
  allow: (key: string) => boolean;
  clientKey: (context: Context) => string;
};

const checkTimeoutMs = 8000;
const uncheckableMessage = "This source cannot be checked";

export const tooManyMessage = "Too many checks. Try again in a minute.";

const labels: Record<Checkable["kind"], { name: string; secret: string }> = {
  titlovi: { name: "Titlovi.com", secret: "username and password" },
  subdl: { name: "SubDL", secret: "API key" },
  subsource: { name: "SubSource", secret: "API key" },
};

const isCheckable = (source: SourceSettings): source is Checkable => source.kind in labels;

const runCheck = (source: Checkable): Promise<Verdict> => {
  switch (source.kind) {
    case "titlovi":
      return checkTitlovi(source, checkTimeoutMs);
    case "subdl":
      return checkSubDL(source.apiKey, checkTimeoutMs);
    case "subsource":
      return checkSubSource(source.apiKey, checkTimeoutMs);
  }
};

export const sourceCheckRoute =
  ({ allow, clientKey }: SourceCheckDeps) =>
  async (context: Context) => {
    context.header("Cache-Control", "no-store");

    if (!allow(clientKey(context))) {
      return context.json({ error: tooManyMessage }, 429);
    }

    const body = v.safeParse(sourceSchema, await context.req.json().catch(() => undefined), {
      message: uncheckableMessage,
    });

    if (!body.success || !isCheckable(body.output)) {
      return context.json(
        { error: body.success ? uncheckableMessage : body.issues[0].message },
        400,
      );
    }

    const { name, secret } = labels[body.output.kind];
    const verdict = await runCheck(body.output).catch((): Verdict => "unreachable");
    const answers: Record<Verdict, { ok: boolean; error?: string }> = {
      accepted: { ok: true },
      rejected: { ok: false, error: `${name} did not accept this ${secret}.` },
      unreachable: { ok: false, error: `Could not reach ${name} right now. Try again.` },
    };

    return context.json(answers[verdict]);
  };
