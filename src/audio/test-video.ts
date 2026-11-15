import { spawn, spawnSync } from "node:child_process";
import type { Cue } from "../subtitles/cue.ts";
import { fundamental, harmonics, sampleRate } from "../timing/test-audio.ts";

export const ffmpeg = process.env.SUBSONTIME_FFMPEG || "ffmpeg";

export const hasFFmpeg = spawnSync(ffmpeg, ["-version"]).status === 0;

const seconds = (ms: number) => (ms / 1000).toFixed(3);

const voiced = [
  `st(0,2*PI*(${fundamental}*t-(30/(6*PI))*(cos(6*PI*t)-1)))`,
  `(${harmonics.map((harmonic) => `${harmonic.gain.toFixed(5)}*sin(${harmonic.multiple}*ld(0))`).join("+")})*0.3*(0.55+0.45*sin(8*PI*t))*8000/32768`,
].join(";");

const gate = (bursts: Cue[]) =>
  `gt(${bursts.map((cue) => `between(t,${seconds(cue.start)},${seconds(cue.end)})`).join("+")},0)`;

export const run = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], {
      stdio: ["ignore", "ignore", "inherit"],
    });

    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)),
    );
  });

const picture = (durationMs: number) => [
  "-f",
  "lavfi",
  "-i",
  `color=c=black:s=16x16:r=1:d=${seconds(durationMs)}`,
];

export const writeBursts = (path: string, bursts: Cue[], durationMs: number) =>
  run([
    ...picture(durationMs),
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=exprs='if(${gate(bursts)},${voiced},0)':s=${sampleRate}:d=${seconds(durationMs)}`,
    "-c:v",
    "ffv1",
    "-c:a",
    "flac",
    path,
  ]);

export const writeSilentPicture = (path: string, durationMs: number) =>
  run([...picture(durationMs), "-c:v", "ffv1", path]);
