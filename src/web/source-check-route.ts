import type { Context } from "hono";
import * as v from "valibot";
import { sourceSchema, type SourceSettings } from "../config/config.ts";
import type { Verdict } from "../sources/check.ts";
import { checkOpenSubtitles, sourceName as openSubtitlesName } from "../sources/opensubtitles.ts";
import { checkSubDL, sourceName as subdlName } from "../sources/subdl.ts";
import { checkSubSource, sourceName as subSourceName } from "../sources/subsource.ts";
import { checkTitlovi, sourceName as titloviName } from "../sources/titlovi.ts";
import { readJSON } from "./config-route.ts";

type Checkable = Extract<
  SourceSettings,
  { kind: "opensubtitles" | "titlovi" | "subdl" | "subsource" }
>;

type SourceCheckDeps = {
  allow: (key: string) => Promise<boolean>;
  clientKey: (context: Context) => string;
  openSubtitlesAppKey?: string;
};

const checkTimeoutMs = 8000;
const uncheckableMessage = "This source cannot be checked";

export const tooManyMessage = "Too many checks. Try again in a minute.";

const labels: Record<Checkable["kind"], { name: string; secret: string }> = {
  opensubtitles: { name: openSubtitlesName, secret: "username and password" },
  titlovi: { name: titloviName, secret: "username and password" },
  subdl: { name: subdlName, secret: "API key" },
  subsource: { name: subSourceName, secret: "API key" },
};

const runCheck = (source: Checkable, appKey: string): Promise<Verdict> => {
  switch (source.kind) {
    case "opensubtitles":
      return checkOpenSubtitles(source, appKey, checkTimeoutMs);
    case "titlovi":
      return checkTitlovi(source, checkTimeoutMs);
    case "subdl":
      return checkSubDL(source.apiKey, checkTimeoutMs);
    case "subsource":
      return checkSubSource(source.apiKey, checkTimeoutMs);
  }
};

export const sourceCheckRoute =
  ({ allow, clientKey, openSubtitlesAppKey }: SourceCheckDeps) =>
  async (context: Context) => {
    const isCheckable = (source: SourceSettings): source is Checkable =>
      source.kind in labels &&
      (source.kind !== "opensubtitles" || openSubtitlesAppKey !== undefined);

    context.header("Cache-Control", "no-store");

    if (!(await allow(clientKey(context)))) {
      return context.json({ error: tooManyMessage }, 429);
    }

    const body = v.safeParse(sourceSchema, await readJSON(context), {
      message: uncheckableMessage,
    });

    if (!body.success || !isCheckable(body.output)) {
      return context.json(
        { error: body.success ? uncheckableMessage : body.issues[0].message },
        400,
      );
    }

    const { name, secret } = labels[body.output.kind];

    const verdict = await runCheck(body.output, openSubtitlesAppKey ?? "").catch(
      (): Verdict => "unreachable",
    );
    const answers: Record<Verdict, { ok: boolean; error?: string }> = {
      accepted: { ok: true },
      rejected: { ok: false, error: `${name} did not accept this ${secret}.` },
      unreachable: { ok: false, error: `Could not reach ${name} right now. Try again.` },
    };

    return context.json(answers[verdict]);
  };
