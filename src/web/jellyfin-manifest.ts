import * as v from "valibot";
import releasesJSON from "../../plugins/jellyfin/releases.json" with { type: "json" };

const fourPartVersion = v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+\.\d+$/));

export const releasesSchema = v.array(
  v.strictObject({
    version: fourPartVersion,
    changelog: v.string(),
    targetAbi: fourPartVersion,
    sourceUrl: v.pipe(v.string(), v.url()),
    checksum: v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/)),
    timestamp: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)),
  }),
);

export const jellyfinRepository = (releases: v.InferOutput<typeof releasesSchema>) => [
  {
    guid: "25644ac2-fc95-4f1f-9beb-21e679183dff",
    name: "Subs On Time",
    description: "Subtitles that fit the file you are playing.",
    overview: "Finds subtitles for the exact video file and retimes them to it.",
    owner: "subsontime",
    category: "Subtitles",
    versions: releases.toSorted((a, b) => b.timestamp.localeCompare(a.timestamp)),
  },
];

export const jellyfinManifest = jellyfinRepository(v.parse(releasesSchema, releasesJSON));
