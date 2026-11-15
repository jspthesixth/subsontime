import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { sampleRate } from "../timing/test-audio.ts";
import { syntheticTrack } from "../timing/test-tracks.ts";
import { alignToAudio } from "./align-audio.ts";
import { hasFFmpeg, run } from "./test-video.ts";

const threeHours = 3 * 60 * 60;
const maximumGrowth = 200 * 1024 * 1024;

if (!hasFFmpeg) {
  process.stderr.write(
    "ffmpeg not found: skipping the 3-hour audio test. Set SUBSONTIME_FFMPEG to run it.\n",
  );
}

describe.skipIf(!hasFFmpeg)("alignToAudio", () => {
  it("aligns 3 hours of piped audio with RSS growth under 200 MB", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subsontime-audio-"));
    const fifo = join(directory, "three-hours.mkv");
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 50);

    try {
      await promisify(execFile)("mkfifo", [fifo]);

      const writer = run([
        "-f",
        "lavfi",
        "-i",
        `sine=f=300:sample_rate=${sampleRate}:d=${threeHours},volume=0:enable='lt(mod(t,4.7),2.3)'`,
        "-c:a",
        "pcm_s16le",
        "-f",
        "matroska",
        fifo,
      ]);
      const result = await alignToAudio(fifo, syntheticTrack(1, 2500));

      await writer;

      expect(result.kind === "aligned" && result.cues.length).toBe(2500);
      expect(peak - before).toBeLessThan(maximumGrowth);
    } finally {
      clearInterval(sampler);
      await rm(directory, { recursive: true, force: true });
    }
  }, 300_000);
});
