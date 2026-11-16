import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { format, parse } from "node:path";
import { promisify } from "node:util";
import * as v from "valibot";
import { toISO6391 } from "../languages.ts";

export const pcmSampleRate = 16000;

export const ffmpegCommand = () => process.env.SUBSONTIME_FFMPEG || "ffmpeg";

export const ffmpegFound = () => spawnSync(ffmpegCommand(), ["-version"]).error === undefined;

const execFileAsync = promisify(execFile);

const flag = v.optional(v.number(), 0);

const probeSchema = v.object({
  streams: v.array(
    v.object({
      tags: v.optional(
        v.object({ language: v.optional(v.string()), title: v.optional(v.string()) }),
        {},
      ),
      disposition: v.optional(v.object({ comment: flag, original: flag, default: flag }), {}),
    }),
  ),
});

export type AudioStream = v.InferInput<typeof probeSchema>["streams"][number];

const probeTimeoutMs = 30_000;

export const ffprobeCommand = () => {
  const { SUBSONTIME_FFPROBE: configured } = process.env;

  if (configured) {
    return configured;
  }

  const { dir, ext } = parse(ffmpegCommand());

  const sibling = format({ dir, name: "ffprobe", ext });

  return dir !== "" && existsSync(sibling) ? sibling : "ffprobe";
};

const baseLanguage = (code: string) => (toISO6391(code) ?? code.toLowerCase()).split("-")[0];

const isCommentary = ({ tags, disposition }: AudioStream) =>
  disposition?.comment === 1 || /commentary/i.test(tags?.title ?? "");

export const chooseAudioStream = (streams: AudioStream[], language: string | undefined) => {
  const candidates = streams.flatMap((stream, index) =>
    isCommentary(stream) ? [] : [{ stream, index }],
  );
  const wanted = language === undefined ? undefined : baseLanguage(language);
  const picks = [
    ({ stream }: (typeof candidates)[number]) =>
      wanted !== undefined &&
      stream.tags?.language !== undefined &&
      baseLanguage(stream.tags.language) === wanted,
    ({ stream }: (typeof candidates)[number]) => stream.disposition?.original === 1,
    ({ stream }: (typeof candidates)[number]) => stream.disposition?.default === 1,
  ];

  return (
    picks.map((pick) => candidates.find(pick)).find((found) => found !== undefined)?.index ??
    candidates[0]?.index ??
    0
  );
};

export const audioStreamOf = async (
  videoPath: string,
  language: string | undefined,
  signal: AbortSignal,
) => {
  signal.throwIfAborted();

  try {
    const { stdout } = await execFileAsync(
      ffprobeCommand(),
      ["-v", "error", "-select_streams", "a", "-show_streams", "-of", "json", `file:${videoPath}`],
      { signal, timeout: probeTimeoutMs, maxBuffer: 16 * 1024 * 1024 },
    );

    return chooseAudioStream(v.parse(probeSchema, JSON.parse(stdout)).streams, language);
  } catch {
    signal.throwIfAborted();

    return 0;
  }
};

const stderrTailLength = 4096;

const decodeArguments = (videoPath: string, stream: number) => [
  "-nostdin",
  "-hide_banner",
  "-loglevel",
  "error",
  "-i",
  `file:${videoPath}`,
  "-map",
  `0:a:${stream}`,
  "-ac",
  "1",
  "-ar",
  String(pcmSampleRate),
  "-f",
  "s16le",
  "-",
];

export const samplesFrom = async function* (bytes: AsyncIterable<Uint8Array>) {
  let carry = new Uint8Array(0);

  for await (const chunk of bytes) {
    const joined = new Uint8Array(carry.length + chunk.length);
    const whole = joined.length - (joined.length % 2);

    joined.set(carry);
    joined.set(chunk, carry.length);
    carry = joined.slice(whole);

    if (whole > 0) {
      yield new Int16Array(joined.buffer, 0, whole / 2);
    }
  }
};

export const exitError = (
  code: number | null,
  killedBy: string | null,
  stderr: string,
  videoPath: string,
) => {
  if (stderr.includes("matches no streams")) {
    return new Error("The video has no audio track");
  }

  const lastLine = stderr.replaceAll(videoPath, "the video").trim().split("\n").at(-1) ?? "";

  return new Error(`ffmpeg exited with ${code === null ? killedBy : `code ${code}`}: ${lastLine}`);
};

export const pcmFrom = async function* (videoPath: string, signal: AbortSignal, stream = 0) {
  signal.throwIfAborted();

  const child = spawn(ffmpegCommand(), decodeArguments(videoPath, stream), {
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });
  const closed = new Promise<{ code: number | null; killedBy: string | null }>((resolve) => {
    child.once("close", (code, killedBy) => resolve({ code, killedBy }));
  });
  let spawnError: Error | undefined;
  let stderr = "";

  child.once("error", (error) => {
    spawnError = error;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    stderr = (stderr + text).slice(-stderrTailLength);
  });

  try {
    for await (const samples of samplesFrom(child.stdout)) {
      signal.throwIfAborted();
      yield samples;
    }

    const { code, killedBy } = await closed;

    signal.throwIfAborted();

    if (spawnError !== undefined) {
      throw new Error("ffmpeg is needed for --audio. Install it and try again.");
    }

    if (code !== 0) {
      throw exitError(code, killedBy, stderr, videoPath);
    }
  } finally {
    child.stdout.destroy();
    child.kill();
    await closed;
  }
};
