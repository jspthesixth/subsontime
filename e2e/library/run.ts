import { execFileSync } from "node:child_process";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { timingsClient } from "../../src/cli/timings-client.ts";
import { fileFingerprint } from "../../src/cli/video-hash.ts";

type Film = { imdbId: string; folder: string; url: string };
type RadarrMovie = { id: number; imdbId: string; hasFile: boolean };
type BazarrMovie = { radarrId: number; imdbId: string; profileId: number | null };
type BazarrJob = { job_name: string; status: string };
type BazarrDownload = {
  action: number;
  provider: string;
  score: string;
  language: { code2: string };
  subtitles_path: string;
};

const mediaDir = process.env["MEDIA_DIR"];

if (mediaDir === undefined || mediaDir === "") {
  throw new Error("Set MEDIA_DIR to the folder the stack mounts as /movies");
}

const radarrURL = "http://127.0.0.1:57878/api/v3";
const bazarrURL = "http://127.0.0.1:56767/api";
const openTimingsURL = "http://127.0.0.1:57000";
const openTimingsInBazarr = "http://127.0.0.1:7000";
const postProcessing = `subsontime bazarr --video {{episode}} --subtitle {{subtitles}} --lang {{subtitles_language_code3}} --api ${openTimingsInBazarr}`;
const openSubtitlesUser = process.env["OPENSUBTITLES_USERNAME"];
const openSubtitlesPassword = process.env["OPENSUBTITLES_PASSWORD"];
const hasOpenSubtitles = Boolean(openSubtitlesUser) && Boolean(openSubtitlesPassword);
const providers = [
  "yifysubtitles",
  "subtitlecat",
  ...(hasOpenSubtitles ? ["opensubtitlescom"] : []),
];
const languages = ["en", "hr"];
const films: Film[] = [
  {
    imdbId: "tt0063350",
    folder: "Night of the Living Dead (1968)",
    url: "https://archive.org/download/NightOfTheLivingDead-MPEG/NightOfTheLivingDead_512kb.mp4",
  },
  {
    imdbId: "tt0052077",
    folder: "Plan 9 from Outer Space (1959)",
    url: "https://archive.org/download/plan-9-from-outer-space_202011/Plan%209%20from%20Outer%20Space%20%20%20Ed%20Wood%20%28full%20movie%29.mp4",
  },
];

const step = (text: string) => console.log(`\n== ${text}`);

const videoOf = ({ folder }: Film) => join(mediaDir, folder, `${folder}.mp4`);

const inContainer = (service: string, ...command: string[]) =>
  execFileSync("docker", ["exec", `subsontime-e2e-${service}-1`, ...command], {
    encoding: "utf8",
  });

const waitFor = async <T>(label: string, seconds: number, check: () => Promise<T | undefined>) => {
  const deadline = Date.now() + seconds * 1000;

  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);

    if (value !== undefined) {
      return value;
    }

    await sleep(2000);
  }

  throw new Error(`${label} did not happen within ${seconds} s`);
};

const call = async (url: string, key: string, init: RequestInit = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: { "X-Api-Key": key, ...init.headers },
  });

  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${url} answered ${response.status}`);
  }

  return response.status === 204 ? undefined : response.json();
};

const keyIn = (service: string, file: string, pattern: RegExp) =>
  waitFor(
    `${service} API key`,
    120,
    async () => pattern.exec(inContainer(service, "cat", file))?.[1],
  );

const downloadFilms = async () => {
  step("films");

  for (const film of films) {
    const path = videoOf(film);
    const present = await access(path).then(
      () => true,
      () => false,
    );

    if (!present) {
      await mkdir(join(mediaDir, film.folder), { recursive: true });

      const response = await fetch(film.url);

      if (!response.ok || response.body === null) {
        throw new Error(`archive.org answered ${response.status} for ${film.url}`);
      }

      await writeFile(path, response.body);
    }

    const folder = join(mediaDir, film.folder);
    const subtitles = (await readdir(folder)).filter((name) => name.endsWith(".srt"));

    await Promise.all(subtitles.map((name) => rm(join(folder, name))));
    console.log(`${film.folder}: ${present ? "present" : "downloaded"}`);
  }
};

const configureRadarr = async (key: string) => {
  step("Radarr");

  const radarr = (path: string, init?: RequestInit) => call(`${radarrURL}${path}`, key, init);
  const post = (path: string, body: unknown) =>
    radarr(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  await waitFor("Radarr start", 120, () => radarr("/system/status"));

  const roots = (await radarr("/rootfolder")) as { path: string }[];

  if (!roots.some(({ path }) => path === "/movies")) {
    await post("/rootfolder", { path: "/movies" });
  }

  const [profile] = (await radarr("/qualityprofile")) as { id: number }[];
  const added = (await radarr("/movie")) as RadarrMovie[];

  for (const film of films.filter(
    ({ imdbId }) => !added.some((movie) => movie.imdbId === imdbId),
  )) {
    const found = await radarr(`/movie/lookup/imdb?imdbId=${film.imdbId}`);

    await post("/movie", {
      ...(found as object),
      qualityProfileId: profile?.id,
      rootFolderPath: "/movies",
      path: `/movies/${film.folder}`,
      monitored: true,
      addOptions: { searchForMovie: false },
    });
  }

  const movies = await waitFor("Radarr importing both films", 300, async () => {
    const all = (await radarr("/movie")) as RadarrMovie[];

    return all.filter(({ hasFile }) => hasFile).length === films.length ? all : undefined;
  });

  console.log(`${movies.length} films with files`);
};

const configureBazarr = async (key: string, radarrKey: string) => {
  step("Bazarr");

  await waitFor("Bazarr start", 120, () => call(`${bazarrURL}/system/status`, key));

  const profile = {
    profileId: 1,
    name: "en hr",
    cutoff: null,
    items: languages.map((language, index) => ({
      id: index + 1,
      language,
      forced: "False",
      hi: "False",
      audio_exclude: "False",
      audio_only_include: "False",
    })),
    mustContain: [],
    mustNotContain: [],
    originalFormat: false,
  };
  const form = new URLSearchParams([
    ["settings-analytics-enabled", "false"],
    ["settings-general-use_radarr", "true"],
    ["settings-radarr-ip", "radarr"],
    ["settings-radarr-port", "7878"],
    ["settings-radarr-apikey", radarrKey],
    ...languages.map((language) => ["languages-enabled", language]),
    ["languages-profiles", JSON.stringify([profile])],
    ["settings-general-movie_default_enabled", "true"],
    ["settings-general-movie_default_profile", "1"],
    ...providers.map((provider) => ["settings-general-enabled_providers", provider]),
    ["settings-general-use_postprocessing", "true"],
    ["settings-general-postprocessing_cmd", postProcessing],
    ...(hasOpenSubtitles
      ? [
          ["settings-opensubtitlescom-username", openSubtitlesUser ?? ""],
          ["settings-opensubtitlescom-password", openSubtitlesPassword ?? ""],
        ]
      : []),
  ]);

  await call(`${bazarrURL}/system/settings`, key, { method: "POST", body: form });
  console.log(`providers ${providers.join(", ")} · languages ${languages.join(", ")}`);
};

const bazarrMovies = async (key: string) =>
  ((await call(`${bazarrURL}/movies`, key)) as { data: BazarrMovie[] }).data;

const search = async (key: string) => {
  step("search");

  await call(`${bazarrURL}/system/tasks?taskid=update_movies`, key, { method: "POST" });

  const movies = await waitFor("Bazarr syncing both films from Radarr", 180, async () => {
    const synced = await bazarrMovies(key);

    return synced.length === films.length && synced.every(({ profileId }) => profileId === 1)
      ? synced
      : undefined;
  });

  for (const { radarrId } of movies) {
    await call(`${bazarrURL}/movies?radarrid=${radarrId}&action=search-missing`, key, {
      method: "PATCH",
    });
  }

  console.log(`searching ${movies.length} films`);
};

const waitForSearches = async (key: string) => {
  step("wait");

  await waitFor("Bazarr finishing the searches", 1800, async () => {
    const { data } = (await call(`${bazarrURL}/system/jobs`, key)) as { data: BazarrJob[] };
    const searches = data.filter(({ job_name }) => job_name.includes("missing subtitles for"));

    return searches.length === films.length &&
      searches.every(({ status }) => status === "completed" || status === "failed")
      ? searches
      : undefined;
  });
};

const subtitlesOf = async (film: Film) =>
  (await readdir(join(mediaDir, film.folder))).filter(
    (name) => name.endsWith(".srt") && !name.endsWith(".orig.srt"),
  );

const downloadsOf = async (key: string, radarrId: number | undefined) => {
  if (radarrId === undefined) {
    return [];
  }

  const { data } = (await call(`${bazarrURL}/movies/history?radarrid=${radarrId}`, key)) as {
    data: BazarrDownload[];
  };

  return data.filter(({ action }) => action === 1);
};

const resultOf = async (key: string, movies: BazarrMovie[], film: Film) => {
  const radarrId = movies.find(({ imdbId }) => imdbId === film.imdbId)?.radarrId;
  const downloads = await downloadsOf(key, radarrId);
  const beside = await subtitlesOf(film);
  const { fixes, hidden } = await timingsClient(openTimingsURL).lookUp(
    await fileFingerprint(videoOf(film)),
  );
  const audio = fixes.filter(({ method }) => method === "audio").length;

  console.log(`\n${film.folder}`);
  downloads.forEach(({ language, provider, score }) =>
    console.log(`  ${language.code2} from ${provider} · ${score}`),
  );
  console.log(`  beside the film: ${beside.join(", ") || "nothing"}`);
  console.log(
    `  Open Timings: ${audio} audio · ${hidden.map(({ reason, count }) => `${count} ${reason}`).join(", ") || "nothing hidden"}`,
  );

  return [
    ...(downloads.length === 0 ? ["no subtitle downloaded"] : []),
    ...(beside.length === downloads.length ? [] : [`${beside.length} subtitles beside the film`]),
    ...(audio === downloads.length ? [] : [`${audio} audio fixes`]),
  ].map((failure) => `${film.folder}: ${failure} for ${downloads.length} downloads`);
};

const assertFlow = async (key: string) => {
  step("Open Timings");

  const movies = await bazarrMovies(key);
  const failures = [];

  for (const film of films) {
    failures.push(...(await resultOf(key, movies, film)));
  }

  const logLines = inContainer("bazarr", "cat", "/config/log/bazarr.log")
    .split("\n")
    .filter((line) => line.includes("subsontime:"));

  console.log(`\n${logLines.join("\n")}`);

  if (logLines.length === 0) {
    failures.push("no subsontime: line in Bazarr's log");
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }

  console.log("\nBazarr flow proven");
};

await downloadFilms();

const radarrKey = await keyIn("radarr", "/config/config.xml", /<ApiKey>(\w+)<\/ApiKey>/);
const bazarrKey = await keyIn(
  "bazarr",
  "/config/config/config.yaml",
  /^auth:\n(?: .*\n)*? {2}apikey: (\w+)/m,
);

await configureRadarr(radarrKey);
await configureBazarr(bazarrKey, radarrKey);
await search(bazarrKey);
await waitForSearches(bazarrKey);
await assertFlow(bazarrKey);
