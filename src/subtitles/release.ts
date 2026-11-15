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
  [/^(hdtv|pdtv|hdtvrip)$/i, "hdtv"],
  [/^(dvdrip|dvd)$/i, "dvdrip"],
];

const resolutions: [RegExp, NonNullable<Release["resolution"]>][] = [
  [/^(2160p|4k|uhd)$/i, "2160p"],
  [/^1080p$/i, "1080p"],
  [/^720p$/i, "720p"],
  [/^(480p|576p)$/i, "480p"],
];

const tokenize = (text: string) => text.split(/[.\s_[\]()]+/).filter((token) => token !== "");

const withoutGroup = (token: string) => token.replace(/-[A-Za-z0-9]+$/, "");

const matches = (pattern: RegExp, token: string) =>
  pattern.test(token) || pattern.test(withoutGroup(token));

const findLabel = <T>(tokens: string[], table: [RegExp, T][]) =>
  tokens
    .flatMap((token) => table.filter(([pattern]) => matches(pattern, token)).slice(0, 1))
    .at(-1)?.[1];

const isAlias = (token: string) =>
  [...sources, ...resolutions].some(([pattern]) => matches(pattern, token));

const isLabelNoise = (token: string) => /^(forced|sdh|hi|cc)$/i.test(token);

const isTrailingNoise = (token: string) =>
  isLabelNoise(token) || (/^[a-z]{2,3}$/i.test(token) && !isAlias(token));

const dropTrailingNoise = (tokens: string[]): string[] =>
  tokens.length > 1 && isTrailingNoise(tokens.at(-1) ?? "")
    ? dropTrailingNoise(tokens.slice(0, -1))
    : tokens;

const trailingTag = /\s*[[(]([^\])]*)[\])]$/;
const noiseAfterTag = /(?<=[\])])(\.([a-z]{2,3}|forced|sdh|hi|cc))+$/i;

const isCodec = (token: string) =>
  /^(aac|ac3|eac3|dts|ddp?|truehd|atmos|flac|opus|hevc|avc|av1|hdr(10)?|sdr|dv)$/i.test(token);

const dashGroup = (tokens: string[]) => {
  const group = dropTrailingNoise(tokens)
    .at(-1)
    ?.match(/-([A-Za-z0-9]{2,})$/)?.[1];

  return group === undefined || isAlias(group) ? undefined : group;
};

const withoutLabelNoise = (tokens: string[]): string[] =>
  tokens.length > 1 && isLabelNoise(tokens.at(-1) ?? "")
    ? withoutLabelNoise(tokens.slice(0, -1))
    : tokens;

const tagGroup = (tag: string[]) => {
  const last = withoutLabelNoise(tag).at(-1) ?? "";

  return /^[A-Za-z]{2,}[A-Za-z0-9]*$/.test(last) && !isAlias(last) && !isCodec(last)
    ? last
    : undefined;
};

export const parseRelease = (name: string): Release => {
  const stem = name.replace(/\.(mkv|mp4|avi|srt|sub|ass|vtt)$/i, "");
  const tagged = stem.replace(noiseAfterTag, "");
  const tag = tokenize(tagged.match(trailingTag)?.[1] ?? "");
  const releaseTag = tag.some(isAlias);
  const tokens = tokenize(releaseTag ? tagged : stem.replace(trailingTag, ""));

  return {
    source: findLabel(tokens, sources),
    resolution: findLabel(tokens, resolutions),
    group: releaseTag ? (dashGroup(tag) ?? tagGroup(tag)) : dashGroup(tokens),
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

export type ReleaseFamily = { source?: Release["source"]; group: string };

const codecs: [RegExp, string][] = [
  [/(^|[^a-z0-9])([xh]\.?265|hevc)([^a-z0-9]|$)/i, "h265"],
  [/(^|[^a-z0-9])([xh]\.?264|avc)([^a-z0-9]|$)/i, "h264"],
  [/(^|[^a-z0-9])av1([^a-z0-9]|$)/i, "av1"],
];

const codecOf = (filename: string) => codecs.find(([pattern]) => pattern.test(filename))?.[1];

export const releaseSignatureOf = (filename: string) => {
  const { group, resolution } = parseRelease(filename);
  const codec = codecOf(filename);

  return group === undefined
    ? undefined
    : [group.toLowerCase(), resolution ?? "", codec ?? ""].join("|");
};

export const releaseFamilyOf = ({ source, group }: Release): ReleaseFamily | undefined =>
  group === undefined ? undefined : { source, group: group.toLowerCase() };

export const inReleaseFamily = (release: Release, family: ReleaseFamily) =>
  release.group?.toLowerCase() === family.group && release.source === family.source;

const discOrWebSources = new Set<Release["source"]>(["bluray", "dvdrip", "web-dl", "webrip"]);
const ripGroups = new Set(["joy", "tigole", "qxr", "silence", "psa"]);

export const isDiscOrWeb = ({ source }: Release) => discOrWebSources.has(source);

export const looksLikeRip = (filename: string) => {
  const { source, resolution, group } = parseRelease(filename);
  const codec = codecOf(filename);

  return (
    source === undefined &&
    (resolution === "1080p" ||
      resolution === "2160p" ||
      codec === "h265" ||
      codec === "av1" ||
      /(^|[^a-z0-9])10bit([^a-z0-9]|$)/i.test(filename) ||
      ripGroups.has(group?.toLowerCase() ?? ""))
  );
};
