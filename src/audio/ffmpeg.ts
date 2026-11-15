import { spawn, spawnSync } from "node:child_process";

export const pcmSampleRate = 16000;

export const ffmpegCommand = () => process.env.SUBSONTIME_FFMPEG || "ffmpeg";

export const ffmpegFound = () => spawnSync(ffmpegCommand(), ["-version"]).error === undefined;

const stderrTailLength = 4096;

const decodeArguments = (videoPath: string) => [
  "-nostdin",
  "-hide_banner",
  "-loglevel",
  "error",
  "-i",
  `file:${videoPath}`,
  "-map",
  "0:a:0",
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

export const pcmFrom = async function* (videoPath: string, signal: AbortSignal) {
  signal.throwIfAborted();

  const child = spawn(ffmpegCommand(), decodeArguments(videoPath), {
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
