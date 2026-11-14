import packageJSON from "../../package.json" with { type: "json" };

export const manifest = {
  id: "com.subsontime",
  version: packageJSON.version,
  name: "Subs On Time",
  description: "Subtitles that fit the file you are playing.",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: false },
};
