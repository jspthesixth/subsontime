import type { Context } from "hono";
import * as v from "valibot";
import { baseURL } from "../base-url.ts";
import { configSchema, type Config } from "../config/config.ts";
import { invalidLinkMessage, seal, sealedConfigPattern, unseal } from "../config/seal.ts";

type ConfigRouteDeps = { secret: string; publicURL?: string };

const invalidSettingsMessage = "These settings are not valid";
const formSchema = v.omit(configSchema, ["version", "installId"]);
const openSchema = v.object({ installURL: v.string() });

export const toStremioURL = (installURL: string) => {
  const { host, pathname } = new URL(installURL);

  return `stremio://${host}${pathname}`;
};

export const toWebURL = (installURL: string) =>
  `https://web.stremio.com/#/addons?addon=${encodeURIComponent(installURL)}`;

const readJSON = (context: Context): Promise<unknown> => context.req.json().catch(() => undefined);

const sealedConfigOf = (installURL: string) => {
  const link = installURL.trim();
  const segments = URL.canParse(link) ? new URL(link).pathname.split("/") : [];
  const sealed = segments.at(-2) ?? "";

  return segments.at(-1) === "manifest.json" && sealedConfigPattern.test(sealed)
    ? sealed
    : undefined;
};

const sealSafely = (config: Config, secret: string) => {
  try {
    return seal(config, secret);
  } catch {
    return undefined;
  }
};

const unsealSafely = (sealed: string, secret: string) => {
  try {
    return unseal(sealed, secret);
  } catch {
    return undefined;
  }
};

export const createConfigRoute =
  ({ secret, publicURL }: ConfigRouteDeps) =>
  async (context: Context) => {
    const form = v.safeParse(formSchema, await readJSON(context), {
      message: invalidSettingsMessage,
    });

    context.header("Cache-Control", "no-store");

    if (!form.success) {
      return context.json({ error: form.issues[0].message }, 400);
    }

    const sealed = sealSafely(
      { ...form.output, version: 1, installId: crypto.randomUUID() },
      secret,
    );

    if (sealed === undefined) {
      return context.json({ error: invalidSettingsMessage }, 400);
    }

    const installURL = `${baseURL(context, publicURL)}/${sealed}/manifest.json`;

    return context.json({
      installURL,
      stremioURL: toStremioURL(installURL),
      webURL: toWebURL(installURL),
    });
  };

export const openConfigRoute =
  ({ secret }: ConfigRouteDeps) =>
  async (context: Context) => {
    const body = v.safeParse(openSchema, await readJSON(context));
    const sealed = body.success ? sealedConfigOf(body.output.installURL) : undefined;
    const config = sealed === undefined ? undefined : unsealSafely(sealed, secret);

    context.header("Cache-Control", "no-store");

    if (config === undefined) {
      return context.json({ error: invalidLinkMessage }, 400);
    }

    return context.json(config);
  };
