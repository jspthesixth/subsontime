import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import packageJSON from "../package.json" with { type: "json" };
import { hasFFmpeg, writeBursts } from "../src/audio/test-video.ts";
import { parseSubtitle } from "../src/subtitles/parse.ts";
import { writeSRT } from "../src/subtitles/write.ts";
import { syntheticTrack, transform } from "../src/timing/test-tracks.ts";

const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "subsontime-sea-"));
const binary = join(directory, process.platform === "win32" ? "subsontime.exe" : "subsontime");
const spoken = syntheticTrack(1, 30);
const spokenEnd = spoken.at(-1)?.end ?? 0;

beforeAll(async () => {
  await run(process.execPath, [
    "--experimental-strip-types",
    "scripts/build-sea.ts",
    "--out",
    binary,
  ]);
}, 120_000);

afterAll(() => rm(directory, { recursive: true, force: true }));

describe("build-sea", () => {
  it("prints the version and the fix help", async () => {
    const printed = await run(binary, ["--version"]);
    const help = await run(binary, ["fix", "--help"]);

    expect(printed.stdout).toBe(`${packageJSON.version}\n`);
    expect(printed.stderr).toBe("");
    expect(help.stdout).toContain("Usage: subsontime fix <file-or-folder> [options]");
  });

  it.skipIf(!hasFFmpeg)(
    "aligns a subtitle to the soundtrack offline",
    async () => {
      const video = join(directory, "Example.Movie.2024.mkv");
      const subtitle = join(directory, "late.srt");

      await writeBursts(video, spoken, spokenEnd + 2000);
      await writeFile(subtitle, writeSRT(transform(spoken, (time) => time + 2000)));
      await run(binary, [
        "fix",
        video,
        "--lang",
        "en",
        "--offline",
        "--audio",
        "--subtitle",
        subtitle,
      ]);

      const aligned = parseSubtitle(
        await readFile(join(directory, "Example.Movie.2024.en.srt"), "utf8"),
      );

      const misses = aligned.map((cue, index) => Math.abs(cue.start - (spoken[index]?.start ?? 0)));

      expect(aligned).toHaveLength(spoken.length);
      expect(Math.max(...misses)).toBeLessThan(100);
    },
    60_000,
  );
});
