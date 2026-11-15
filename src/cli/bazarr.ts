import { copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  alignToAudio,
  audioAcceptContrast,
  audioMismatchContrast,
  type AudioAlignment,
} from "../audio/align-audio.ts";
import { ffmpegFound } from "../audio/ffmpeg.ts";
import { toISO6391, toISO6392 } from "../languages.ts";
import { sharedFix } from "../stremio/open-timings.ts";
import type { Cue } from "../subtitles/cue.ts";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { writeSRT } from "../subtitles/write.ts";
import { shiftOf } from "../timing/retime.ts";
import {
  anotherVideoReason,
  audioShare,
  exists,
  mismatchShare,
  replaceFile,
  shareAll,
  sharedOf,
  shiftText,
  timingOf,
  unusedReason,
  type Sharing,
} from "./fix.ts";
import { installIdIn } from "./install-id.ts";
import type { CLIDeps } from "./main.ts";
import { defaultAPIURL, timingsClient } from "./timings-client.ts";
import { fileFingerprint } from "./video-hash.ts";

type Aligned = Extract<AudioAlignment, { kind: "aligned" }>;

class UsageError extends Error {}

const usage = "usage: subsontime bazarr --video <path> --subtitle <path> --lang <code3>";
const left = "left as it is";
const inSyncMs = 100;

const options = {
  video: { type: "string" },
  subtitle: { type: "string" },
  lang: { type: "string" },
  private: { type: "boolean" },
  api: { type: "string" },
} as const;

const parse = (argv: string[]) => {
  try {
    return parseArgs({ args: argv, options }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Unreadable arguments");
  }
};

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : "failed").split("\n")[0];

const code3Of = (lang: string) => toISO6392(toISO6391(lang) ?? lang) ?? lang.toLowerCase();

const sharedText = (sent: boolean | undefined) => {
  if (sent === undefined) {
    return "not shared, --private";
  }

  return sent ? "shared" : "not shared, Open Timings did not answer";
};

const inSync = (original: Cue[], { cues, speedRatio }: Aligned) => {
  const { offsetMs, cuts } = shiftOf(original, cues, speedRatio);

  return speedRatio === 1 && cuts === 0 && Math.abs(offsetMs) <= inSyncMs;
};

const rewrite = async (subtitle: string, cues: Cue[]) => {
  const original = join(dirname(subtitle), `${basename(subtitle, extname(subtitle))}.orig.srt`);

  if (!(await exists(original))) {
    await replaceFile(original, (temp) => copyFile(subtitle, temp));
  }

  await replaceFile(subtitle, (temp) => writeFile(temp, writeSRT(cues)));
};

const run = async (argv: string[], deps: CLIDeps) => {
  const { video: videoPath, subtitle, lang, api, private: isPrivate } = parse(argv);

  if (videoPath === undefined || subtitle === undefined) {
    throw new UsageError("Give --video and --subtitle");
  }

  if (api !== undefined && !URL.canParse(api)) {
    throw new UsageError("Give --api as a full address");
  }

  if (extname(subtitle).toLowerCase() !== ".srt") {
    return `${left} · only .srt subtitles are retimed`;
  }

  const sharing: Sharing = isPrivate === true ? "private" : "on";
  const context = {
    sharing,
    timings: isPrivate === true ? undefined : timingsClient(api ?? defaultAPIURL),
    installId: () => installIdIn(deps.configDir),
  };
  const cues = parseSubtitle(
    decodeSubtitle(await readFile(subtitle), lang === undefined ? undefined : code3Of(lang)),
  );
  const video = await fileFingerprint(videoPath);
  const fixed = await sharedFix(cues, await sharedOf(context.timings, video));

  if (fixed?.kind === "shared-fix") {
    const { label, value = "" } = timingOf(fixed, cues);

    await rewrite(subtitle, fixed.cues);

    return `${label} ${value}`;
  }

  if (!ffmpegFound()) {
    return `${left} · ffmpeg is needed to sync to the audio`;
  }

  const audio = await alignToAudio(videoPath, cues);

  if (audio.kind !== "aligned") {
    return `${left} · ${unusedReason(audio)}`;
  }

  const contrast = `contrast ${audio.contrast.toFixed(1)}`;

  if (audio.contrast < audioMismatchContrast) {
    const sent = await shareAll([mismatchShare(video, cues)], context);

    return `${left} · ${anotherVideoReason} (${contrast}) · ${sharedText(sent)}`;
  }

  if (audio.contrast < audioAcceptContrast) {
    return `${left} · ${unusedReason(audio)}`;
  }

  if (inSync(cues, audio)) {
    const sent = await shareAll([audioShare(video, cues)], context);

    return `already in sync with the audio · ${contrast} · ${sharedText(sent)}`;
  }

  await rewrite(subtitle, audio.cues);

  const sent = await shareAll([audioShare(video, audio.cues)], context);

  return `synced to the audio ${shiftText(cues, audio.cues, audio.speedRatio)} · ${contrast} · ${sharedText(sent)}`;
};

export const bazarr = async (argv: string[], deps: CLIDeps) => {
  const line = await run(argv, deps).catch((error: unknown) =>
    error instanceof UsageError
      ? `${firstLine(error)} · ${usage}`
      : `${left} · ${firstLine(error)}`,
  );

  deps.print(`subsontime: ${line}\n`);

  return 0;
};
