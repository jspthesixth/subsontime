import { titloviSource } from "../../src/sources/titlovi.ts";
import { memoryTokenCache } from "../../src/sources/token-cache.ts";

const required = (name: string) => {
  const value = process.env[name];

  if (value === undefined || value === "") {
    throw new Error(`Set ${name}`);
  }

  return value;
};

const username = required("TITLOVI_USERNAME");
const password = required("TITLOVI_PASSWORD");
const signal = () => AbortSignal.timeout(10000);

const source = titloviSource({ username, password }, memoryTokenCache());
const candidates = await source.search(
  { type: "movie", imdbId: "tt0111161", languages: ["hrv"] },
  signal(),
);

console.log("search results", candidates.length);

const first = candidates[0];

if (first !== undefined) {
  const bytes = await source.download(first.ref, signal());

  console.log("downloaded bytes", bytes.length);
}
