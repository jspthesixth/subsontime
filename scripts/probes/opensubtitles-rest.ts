import { openSubtitlesSource } from "../../src/sources/opensubtitles.ts";
import { memorySharedState } from "../../src/jobs/shared-state.ts";
import { installKeyOf, tokenCacheFor } from "../../src/sources/token-cache.ts";

const required = (name: string) => {
  const value = process.env[name];

  if (value === undefined || value === "") {
    throw new Error(`Set ${name}`);
  }

  return value;
};

const appKey = required("OPENSUBTITLES_APP_KEY");
const username = required("OPENSUBTITLES_USERNAME");
const password = required("OPENSUBTITLES_PASSWORD");
const imdbId = "tt0111161";
const hash = "8e245d9679d31e12";
const languages = ["hrv", "eng"];
const signal = () => AbortSignal.timeout(10000);

const source = openSubtitlesSource(
  { username, password },
  appKey,
  tokenCacheFor(memorySharedState(), installKeyOf("")),
);
const byImdb = await source.search({ type: "movie", imdbId, languages }, signal());
const byHash = await source.search({ type: "movie", imdbId, videoHash: hash, languages }, signal());

console.log("search by imdb_id", byImdb.length);
console.log("search by moviehash", byHash.length);
console.log("moviehash matches", byHash.filter((candidate) => candidate.hashMatch).length);
console.log("with fps", byImdb.filter((candidate) => candidate.fps !== undefined).length);

const first = byImdb[0];

if (first !== undefined) {
  const bytes = await source.download(first.ref, signal());

  console.log("downloaded bytes", bytes.length);
}
