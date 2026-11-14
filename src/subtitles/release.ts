export type Release = {
  source?: "bluray" | "web-dl" | "webrip" | "hdtv" | "dvdrip";
  resolution?: "2160p" | "1080p" | "720p" | "480p";
  group?: string;
  extended: boolean;
};

const sources: [RegExp, NonNullable<Release["source"]>][] = [
  [/^(bluray|blu-ray|bdrip|brrip|bdremux|remux)$/i, "bluray"],
  [/^(web-dl|webdl|web)$/i, "web-dl"],
  [/^webrip$/i, "webrip"],
  [/^hdtv$/i, "hdtv"],
  [/^(dvdrip|dvd)$/i, "dvdrip"],
];

const resolutions: [RegExp, NonNullable<Release["resolution"]>][] = [
  [/^(2160p|4k|uhd)$/i, "2160p"],
  [/^1080p$/i, "1080p"],
  [/^720p$/i, "720p"],
  [/^(480p|576p)$/i, "480p"],
];

const tokenize = (text: string) => text.split(/[.\s_[\]()]+/).filter((token) => token !== "");

const findLabel = <T>(tokens: string[], table: [RegExp, T][]) =>
  table.find(([pattern]) => tokens.some((token) => pattern.test(token)))?.[1];

export const parseRelease = (name: string): Release => {
  const base = name
    .replace(/\.(mkv|mp4|avi|srt|sub|ass|vtt)$/i, "")
    .replace(/\s*[[(][^\])]*[\])]$/, "");
  const tokens = tokenize(base);
  const group = tokens.at(-1)?.match(/-([A-Za-z0-9]{2,})$/)?.[1];

  return {
    source: findLabel(tokens, sources),
    resolution: findLabel(tokens, resolutions),
    group,
    extended: tokens.some(
      (token, index) =>
        /^(extended|uncut|unrated)$/i.test(token) ||
        (/^directors$/i.test(token) && /^cut$/i.test(tokens[index + 1] ?? "")),
    ),
  };
};

const sameGroup = (a: Release, b: Release) =>
  a.group !== undefined && b.group !== undefined && a.group.toLowerCase() === b.group.toLowerCase();

export const sameRelease = (a: Release, b: Release) =>
  a.source !== undefined &&
  a.source === b.source &&
  a.resolution !== undefined &&
  a.resolution === b.resolution &&
  sameGroup(a, b);

export const releaseSimilarity = (a: Release, b: Release) =>
  [
    a.source !== undefined && a.source === b.source,
    a.resolution !== undefined && a.resolution === b.resolution,
    sameGroup(a, b),
  ].filter(Boolean).length;
