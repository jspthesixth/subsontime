import { subSourceSource } from "../../src/sources/subsource.ts";

const apiKey = process.env["SUBSOURCE_API_KEY"];

if (apiKey === undefined || apiKey === "") {
  throw new Error("Set SUBSOURCE_API_KEY");
}

const signal = () => AbortSignal.timeout(10000);
const source = subSourceSource(apiKey);

const counts = await Promise.all(
  ["hrv", "srp", "eng"].map(async (lang) => {
    const candidates = await source.search(
      { type: "movie", imdbId: "tt0111161", languages: [lang] },
      signal(),
    );

    return { lang, candidates };
  }),
);

counts.forEach(({ lang, candidates }) => console.log(lang, "results", candidates.length));
console.log(
  "Balkan names (croatian, serbian) verified when their counts above are above zero; bosnian, slovenian and macedonian are unverified",
);

const first = counts.flatMap(({ candidates }) => candidates)[0];

if (first !== undefined) {
  const bytes = await source.download(first.ref, signal());

  console.log("entry bytes", bytes.length);
}
