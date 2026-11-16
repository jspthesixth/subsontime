import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseRelease } from "../subtitles/release.ts";
import { retimedSources, shifted, track } from "../stremio/test-app.ts";
import { syntheticTrack, transform } from "../timing/test-tracks.ts";
import { benchFile, cachingFetch, countOutcomes, dailyLedger, tierOf } from "./stremio-bench.ts";
import { availabilityOf, candidateKey, signalsOf } from "./oracle.ts";
import { shapeOf, truthOf } from "./truth.ts";

const verified = [{ id: "v", lang: "eng", cues: track }];
const french = track.map((cue, index) => ({ ...cue, text: `Réplique numéro ${index}` }));
const unrelated = syntheticTrack(7, 200).map((cue, index) => ({ ...cue, text: `Other ${index}` }));

describe("truthOf", () => {
  it("measures a served copy of a verified subtitle cue by cue", async () => {
    expect(await truthOf(shifted, "eng", verified)).toMatchObject({
      method: "text",
      outcome: "wrong-timing",
      matched: 100,
      medianMs: 2000,
      p90Ms: 2000,
    });
    expect(await truthOf(track, "eng", verified)).toMatchObject({
      method: "text",
      outcome: "correct",
      medianMs: 0,
    });
  });

  it("aligns another language to the verified timing", async () => {
    expect(await truthOf(french, "fre", verified)).toMatchObject({
      method: "alass",
      outcome: "correct",
      medianMs: 0,
    });
    expect(
      await truthOf(
        transform(french, (time) => time + 3000),
        "fre",
        verified,
      ),
    ).toMatchObject({ method: "alass", outcome: "wrong-timing", medianMs: 3000 });
  });

  it("calls a subtitle of another title wrong", async () => {
    expect(await truthOf(unrelated, "eng", verified)).toMatchObject({ outcome: "wrong-title" });
  });
});

describe("benchFile", () => {
  it("runs the listing and the file route and judges the served cues", async () => {
    const [run] = await benchFile({
      file: { sha256: "f", kind: "film", imdbId: "tt0111161", path: "/x/Film.mkv", verified },
      filename: "Film.2020.1080p.BluRay.x264-GRP.mkv",
      fingerprint: { hash: "0123456789abcdef", size: 1_234_567 },
      languages: ["eng"],
      sourcesFor: () => retimedSources(),
    });

    expect(run).toMatchObject({
      lang: "eng",
      outcome: "correct",
      tier: "hash",
      downloads: 2,
      truth: { method: "text", medianMs: 0 },
    });
  });

  it("records nothing served when no source lists the language", async () => {
    const runs = await benchFile({
      file: { sha256: "f", kind: "film", imdbId: "tt0111161", path: "/x/Film.mkv", verified },
      filename: "Film.mkv",
      fingerprint: { hash: "0123456789abcdef", size: 1_234_567 },
      languages: ["fre"],
      sourcesFor: () => retimedSources(),
    });

    expect(countOutcomes(runs)).toEqual({
      correct: 0,
      "wrong-timing": 0,
      "wrong-title": 0,
      unmeasurable: 0,
      nothing: 1,
    });
  });
});

const candidate = (ref: string, releaseName: string) => ({
  sourceName: "OpenSubtitles",
  ref,
  lang: "eng",
  release: parseRelease(releaseName),
  hashMatch: false,
});

describe("tierOf", () => {
  const seen = new Map([
    ["OpenSubtitles\nsame", candidate("same", "Film.2020.1080p.BluRay.x264-GRP")],
    ["OpenSubtitles\nweb", candidate("web", "Film.2020.1080p.WEB-DL.x264-OTHER")],
  ]);
  const listed = { n: "OpenSubtitles", r: "listed", l: "eng" };

  it("names the evidence behind the references", () => {
    const filename = "Film.2020.1080p.BluRay.x264-GRP.mkv";

    expect(tierOf({ c: [{ ...listed, h: 1 }], x: [] }, seen, filename)).toBe("hash");
    expect(tierOf({ c: [listed], x: [] }, seen, filename)).toBe("none");
    expect(tierOf({ c: [listed], x: [listed] }, seen, filename)).toBe("none");
    expect(
      tierOf({ c: [listed], x: [{ n: "OpenSubtitles", r: "same", l: "eng" }] }, seen, filename),
    ).toBe("exact-release");
    expect(
      tierOf(
        { c: [listed], x: [{ n: "OpenSubtitles", r: "web", l: "eng" }] },
        seen,
        "Film (2020) (1080p x265 10bit Joy).mkv",
      ),
    ).toBe("disc-web-default");
  });
});

describe("cachingFetch", () => {
  it("answers a repeated request from disk and budgets REST downloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-"));
    const upstream = vi.fn<typeof fetch>(async () => new Response("listing", { status: 200 }));
    const cached = cachingFetch({
      dir,
      seeds: new Map(),
      restDownloadsLeft: dailyLedger(join(dir, "ledger.json"), 0),
      upstream,
    });

    await cached.fetch("https://example.com/list.json");

    const again = await cached.fetch("https://example.com/list.json");

    expect(await again.text()).toBe("listing");
    expect(upstream).toHaveBeenCalledTimes(1);
    await expect(
      cached.fetch("https://api.example.com/api/v1/download", { method: "POST", body: "{}" }),
    ).rejects.toThrow("The bench REST download budget is spent");
    expect(cached.counts).toEqual({ network: 1, restDownloads: 0, refused: 1 });
  });

  it("spends a daily ledger once per download", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-"));
    const left = dailyLedger(join(dir, "ledger.json"), 1, () => new Date("2026-11-16T10:00:00Z"));

    expect([await left(), await left()]).toEqual([true, false]);
  });
});

describe("shapeOf", () => {
  const at = Array.from({ length: 200 }, (_, index) => index * 30_000);

  it("names a constant offset, a frame rate and steps", () => {
    expect(shapeOf(at.map((time) => ({ at: time, diff: 2000 })))).toEqual({
      kind: "offset",
      offsetMs: 2000,
      speedRatio: 1,
      steps: 0,
    });
    expect(
      shapeOf(at.map((time) => ({ at: time, diff: time - time / (25 / 23.976) }))),
    ).toMatchObject({ kind: "frame-rate", speedRatio: expect.closeTo(25 / 23.976, 4) });
    expect(
      shapeOf(at.map((time, index) => ({ at: time, diff: index < 100 ? 0 : 5000 }))),
    ).toMatchObject({ kind: "steps", steps: 1 });
  });
});

const listed = (ref: string, releaseName: string, fps?: number) => ({
  sourceName: "OpenSubtitles",
  ref,
  lang: "eng",
  releaseName,
  hashMatch: false,
  fps,
});

describe("oracle", () => {
  const served = listed("served", "Film.2020.720p.WEB-DL.x264-OTHER", 25);
  const right = listed("right", "Film.2020.1080p.BluRay.x264-GRP", 23.976);
  const truths = new Map([
    [candidateKey(served), { outcome: "wrong-timing" as const }],
    [candidateKey(right), { outcome: "correct" as const }],
  ]);
  const run = { outcome: "wrong-timing" as const, candidates: [right, served] };

  it("finds a correct candidate that was not chosen and the signals that pick it", () => {
    expect(availabilityOf(run, truths, [right, served])).toBe("correct-not-chosen");
    expect(availabilityOf({ ...run, candidates: [served] }, truths, [right, served])).toBe(
      "cross-language-only",
    );
    expect(availabilityOf({ ...run, candidates: [served] }, truths, [served])).toBe("none-correct");
    expect(
      signalsOf(
        { ...run, servedRef: { n: "OpenSubtitles", r: "served" } },
        truths,
        "Film.2020.1080p.BluRay.x264-GRP.mkv",
      ),
    ).toEqual([
      "release name",
      "group",
      "source",
      "resolution",
      "fps 25 served, 23.976 correct",
      "listed earlier",
    ]);
  });
});
