import { subdlSource } from "../../src/sources/subdl.ts";

const apiKey = process.env["SUBDL_API_KEY"];

if (apiKey === undefined || apiKey === "") {
  throw new Error("Set SUBDL_API_KEY");
}

const signal = () => AbortSignal.timeout(10000);
const source = subdlSource(apiKey);

const counts = await Promise.all(
  ["hrv", "eng"].map(async (lang) => {
    const candidates = await source.search(
      { type: "movie", imdbId: "tt0111161", languages: [lang] },
      signal(),
    );

    return { lang, candidates };
  }),
);

counts.forEach(({ lang, candidates }) => console.log(lang, "results", candidates.length));

const first = counts.flatMap(({ candidates }) => candidates)[0];

if (first !== undefined) {
  const bytes = await source.download(first.ref, signal());

  console.log("entry bytes", bytes.length);
}
