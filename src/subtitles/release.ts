import {
  parseEdition,
  parseResolution,
  parseSource,
  parseVideoCodec,
  Resolution,
  Source,
  VideoCodec,
} from "@ctrl/video-filename-parser";

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

const sourceOf = new Map<Source, NonNullable<Release["source"]>>([
  [Source.BLURAY, "bluray"],
  [Source.WEBDL, "web-dl"],
  [Source.WEBRIP, "webrip"],
  [Source.TV, "hdtv"],
  [Source.DVD, "dvdrip"],
]);

export const releaseSources = [...new Set(sourceOf.values())];

const resolutionOf = new Map<Resolution, NonNullable<Release["resolution"]>>([
  [Resolution.R2160P, "2160p"],
  [Resolution.R1080P, "1080p"],
  [Resolution.R720P, "720p"],
  [Resolution.R576P, "480p"],
  [Resolution.R540P, "480p"],
  [Resolution.R480P, "480p"],
]);

const codecOf = new Map<VideoCodec, string>([
  [VideoCodec.X265, "h265"],
  [VideoCodec.H265, "h265"],
  [VideoCodec.X264, "h264"],
  [VideoCodec.H264, "h264"],
  [VideoCodec.AV1, "av1"],
  [VideoCodec.XVID, "xvid"],
]);

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

const isAlias = (token: string) =>
  [...sources, ...resolutions].some(([pattern]) => matches(pattern, token));

const isLabelNoise = (token: string) => /^(forced|sdh|hi|cc|multi|dual)$/i.test(token);

const isWholeAlias = (token: string) =>
  [...sources, ...resolutions].some(([pattern]) => pattern.test(token));

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
  const kept = dropTrailingNoise(tokens);
  const last = kept.at(-1) ?? "";
  const group = last.match(/-([A-Za-z0-9]{2,})$/)?.[1];

  return group === undefined || kept.length < 2 || isWholeAlias(last) || isAlias(group)
    ? undefined
    : group;
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

const isTitleBoundary = (token: string) =>
  /^((19|20)\d\d|s\d+(e\d+)?|\d+x\d+)$/i.test(token) || isAlias(token);

const withoutTitleVideoStandards = (tokens: string[]) => {
  const boundary = tokens.findIndex(isTitleBoundary);

  return tokens.filter(
    (token, index) => !/^(pal|ntsc)$/i.test(token) || (boundary !== -1 && index > boundary),
  );
};

export const parseRelease = (name: string): Release => {
  const stem = name.replace(/\.(mkv|mp4|avi|srt|sub|ass|vtt)$/i, "");
  const tagged = stem.replace(noiseAfterTag, "");
  const tag = tokenize(tagged.match(trailingTag)?.[1] ?? "");
  const releaseTag = tag.some(isAlias);
  const tokens = tokenize(releaseTag ? tagged : tagged.replace(trailingTag, ""));
  const named = withoutTitleVideoStandards(tokens).join(".");
  const { extended, unrated, directors } = parseEdition(named);

  const resolution = parseResolution(named).resolution;

  return {
    source: parseSource(named)
      .map((source) => sourceOf.get(source))
      .find((source) => source !== undefined),
    resolution: resolution === undefined ? undefined : resolutionOf.get(resolution),
    group: releaseTag ? (dashGroup(tag) ?? tagGroup(tag)) : dashGroup(tokens),
    extended:
      extended === true ||
      unrated === true ||
      directors === true ||
      tokens.some((token) => /^uncut$/i.test(token)),
  };
};

const equivalentGroups = [
  ["lol", "dimension"],
  ["asap", "immerse", "fleet"],
  ["avs", "sva"],
];

const groupsOf = (group: string) =>
  equivalentGroups.find((groups) => groups.includes(group)) ?? [group];

export const sameGroup = (a: Release, b: Release) =>
  a.group !== undefined &&
  b.group !== undefined &&
  groupsOf(a.group.toLowerCase()).includes(b.group.toLowerCase());

export const sameRelease = (a: Release, b: Release) =>
  a.source !== undefined &&
  a.source === b.source &&
  a.resolution !== undefined &&
  a.resolution === b.resolution &&
  sameGroup(a, b);

export type ReleaseFamily = { source?: Release["source"]; group: string };

export const videoCodecOf = (filename: string) => {
  const { codec } = parseVideoCodec(filename);

  return codec === undefined ? undefined : codecOf.get(codec);
};

export const releaseSignatureOf = (filename: string) => {
  const { group, resolution } = parseRelease(filename);

  const codec = videoCodecOf(filename);

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

  const codec = videoCodecOf(filename);

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

export type SourceKind = "disc" | "web" | "tv";

const sourceKinds: Record<NonNullable<Release["source"]>, SourceKind> = {
  bluray: "disc",
  dvdrip: "disc",
  "web-dl": "web",
  webrip: "web",
  hdtv: "tv",
};

export const sourceKindOf = ({ source }: Release) =>
  source === undefined ? undefined : sourceKinds[source];

export const isHearingImpaired = (name: string) => /(^|[^a-z0-9])(hi|sdh)([^a-z0-9]|$)/i.test(name);
