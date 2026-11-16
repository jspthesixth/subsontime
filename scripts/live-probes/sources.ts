import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { memorySharedState } from "../../src/jobs/shared-state.ts";
import { openSubtitlesSource } from "../../src/sources/opensubtitles.ts";
import { downloadBudget, openSubtitlesListing } from "../../src/sources/opensubtitles-hash.ts";
import type { Source, VideoQuery } from "../../src/sources/source.ts";
import { openSubtitlesAddonURL } from "../../src/config/default-config.ts";
import { openSubtitlesV3Name } from "../../src/sources/from-config.ts";
import { stremioAddonSource } from "../../src/sources/stremio-addon.ts";
import { titloviSource } from "../../src/sources/titlovi.ts";
import { installKeyOf, tokenCacheFor } from "../../src/sources/token-cache.ts";

const { values } = parseArgs({
  options: { record: { type: "string" }, download: { type: "boolean", default: false } },
});

const nightOfTheLivingDead: VideoQuery = {
  type: "movie",
  imdbId: "tt0063350",
  languages: ["eng", "hrv", "srp"],
};
const gilmoreGirls: VideoQuery = {
  type: "series",
  imdbId: "tt0238784",
  season: 5,
  episode: 17,
  languages: ["eng", "hrv", "srp"],
};
const peterPanFile: VideoQuery = {
  type: "movie",
  imdbId: "tt0046183",
  videoHash: "466d8f728dbe2142",
  videoSize: 1394609539,
  languages: ["eng", "hrv"],
};

const openSubtitlesV3 = stremioAddonSource(openSubtitlesAddonURL, openSubtitlesV3Name);
const realFetch = globalThis.fetch;
const signal = () => AbortSignal.timeout(15000);
let step = "";
let request = 0;

const rowsOf = (body: unknown) =>
  Object.values(typeof body === "object" && body !== null ? body : {}).find(Array.isArray) as
    | unknown[]
    | undefined;

const fieldsOf = (rows: unknown[]) =>
  [...new Set(rows.flatMap((row) => Object.keys(Object(Object(row).attributes ?? row))))]
    .toSorted()
    .join(",");

const record = async (name: string, bytes: ArrayBuffer, json: boolean) => {
  if (values.record === undefined) {
    return;
  }

  await mkdir(values.record, { recursive: true });
  await writeFile(join(values.record, `${name}.${json ? "json" : "bin"}`), Buffer.from(bytes));
};

globalThis.fetch = async (input, init) => {
  if (step.endsWith("rest-down") && String(input).startsWith("https://api.opensubtitles.com")) {
    throw new Error("The probe keeps REST down");
  }

  const response = await realFetch(input, init);
  const bytes = await response.clone().arrayBuffer();
  const body = await response
    .clone()
    .json()
    .catch(() => undefined);
  const rows = rowsOf(body);
  const shape =
    body === undefined
      ? `${bytes.byteLength} bytes`
      : `keys ${Object.keys(body ?? {})
          .toSorted()
          .join(",")}`;

  request += 1;
  console.log(step, request, response.status, shape);

  if (rows !== undefined) {
    console.log(step, request, "rows", rows.length, "fields", fieldsOf(rows));
  }

  await record(`${step}-${request}`, bytes, body !== undefined);

  return response;
};

const probe = async (name: string, run: () => Promise<number>) => {
  step = name;
  request = 0;

  try {
    console.log(name, "result", await run());
  } catch (error) {
    console.log(name, "failed", error instanceof Error ? error.name : "unknown");
  }
};

const downloadFirst = (name: string, source: Source, query: VideoQuery) =>
  probe(name, async () => {
    const [first] = await source.search(query, signal());

    return first === undefined ? 0 : (await source.download(first.ref, signal())).length;
  });

const tokens = () => tokenCacheFor(memorySharedState(), "probe", installKeyOf(""));

const listingWith = (key: string, dailyDownloads: number) => {
  const state = memorySharedState();

  return openSubtitlesListing({
    manifestURL: "https://opensubtitles-v3.strem.io/manifest.json",
    name: "OpenSubtitles",
    appKey: key,
    state,
    budget: downloadBudget(state, dailyDownloads),
    rest: openSubtitlesSource(undefined, key, tokens()),
  });
};

const countFree = async (source: Source, query: VideoQuery) => {
  const candidates = await source.search(query, signal());

  return candidates.filter(({ metered }) => metered !== true).length;
};

const appKey = process.env["OPENSUBTITLES_APP_KEY"];
const titloviUsername = process.env["TITLOVI_USERNAME"];
const titloviPassword = process.env["TITLOVI_PASSWORD"];

if (appKey === undefined || appKey === "") {
  console.log("OpenSubtitles REST skipped: set OPENSUBTITLES_APP_KEY");
} else {
  const rest = openSubtitlesSource(undefined, appKey, tokens());

  await probe(
    "os-rest-movie",
    async () => (await rest.search(nightOfTheLivingDead, signal())).length,
  );
  await probe("os-rest-series", async () => (await rest.search(gilmoreGirls, signal())).length);
  await probe("os-rest-hash", async () => (await rest.search(peterPanFile, signal())).length);

  await probe(
    "os-listing-movie",
    async () => (await listingWith(appKey, 1).search(nightOfTheLivingDead, signal())).length,
  );
  await probe("os-listing-movie-free", () =>
    countFree(listingWith(appKey, 0), nightOfTheLivingDead),
  );
  await probe(
    "os-listing-hash",
    async () => (await listingWith(appKey, 1).search(peterPanFile, signal())).length,
  );
  await probe("os-listing-series-free", () => countFree(listingWith(appKey, 0), gilmoreGirls));
  await probe("os-listing-rest-down", () =>
    countFree(listingWith(appKey, 0), nightOfTheLivingDead),
  );

  if (values.download) {
    await downloadFirst("os-rest-download", rest, nightOfTheLivingDead);
    await downloadFirst("os-listing-free-download", listingWith(appKey, 0), nightOfTheLivingDead);
  }
}

await probe(
  "os-v3-movie",
  async () => (await openSubtitlesV3.search(nightOfTheLivingDead, signal())).length,
);
await probe(
  "os-v3-hash",
  async () => (await openSubtitlesV3.search(peterPanFile, signal())).length,
);

if (values.download) {
  await downloadFirst("os-v3-download", openSubtitlesV3, nightOfTheLivingDead);
}

if (titloviUsername === undefined || titloviPassword === undefined) {
  console.log("Titlovi.com skipped: set TITLOVI_USERNAME and TITLOVI_PASSWORD");
} else {
  const titlovi = titloviSource({ username: titloviUsername, password: titloviPassword }, tokens());

  await probe(
    "titlovi-movie",
    async () => (await titlovi.search(nightOfTheLivingDead, signal())).length,
  );
  await probe("titlovi-series", async () => (await titlovi.search(gilmoreGirls, signal())).length);

  if (values.download) {
    await downloadFirst("titlovi-download", titlovi, nightOfTheLivingDead);
  }
}
