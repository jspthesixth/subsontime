import { fromLocales } from "../../languages.ts";
import type { CheckRow } from "../check-route.ts";
import { combobox } from "./lib/combobox.ts";
import { clone, find } from "./lib/dom.ts";
import { errorOf, postJSON } from "./lib/post-json.ts";
import { sizeText } from "./lib/size-text.ts";
import { videoHash } from "./lib/video-hash.ts";

type Title = { id: string; type: "movie" | "series"; name: string; year?: string };
type Episode = { season: number; episode: number; name: string };
type VideoFile = { hash: string; size: number; name: string };
type CheckResult = {
  shown: CheckRow[];
  leftOut: CheckRow[];
  reference?: string;
  searchedMs: number;
  sources: number;
};

const searchDelayMs = 250;
const minimumQueryLength = 2;
const maximumLanguages = 10;
const unknownRelease = "Unknown release";
const retimedPath = "M2 8h9M8 4.5L11.5 8 8 11.5M14 3v10";
const notRetimedPath = "M3 8h10";
const timingPaths: Record<string, string> = {
  "Made for this file": "M3 8.5l3 3 7-7",
  Retimed: retimedPath,
  "Retimed by release name": retimedPath,
};

const titleInput = find<HTMLInputElement>(document, "#title");
const titleOptions = find(document, "#title-options");
const episodePick = find(document, "#episode-pick");
const seasonSelect = find<HTMLSelectElement>(document, "#season");
const episodeSelect = find<HTMLSelectElement>(document, "#episode");
const linkInput = find<HTMLInputElement>(document, "#link");
const drop = find(document, "#drop");
const fileInput = find<HTMLInputElement>(document, "#video-file");
const dropName = find(document, "#drop-name");
const dropDetail = find(document, "#drop-detail");
const dropAction = find(document, "#drop-action");
const form = find<HTMLFormElement>(document, "#check-form");
const checkButton = find<HTMLButtonElement>(document, "#check");
const checkError = find(document, "#check-error");
const checkStatus = find(document, "#check-status");
const results = find(document, "#results");
const shownHead = find(document, "#shown-head");
const shownRows = find(document, "#shown-rows");
const leftOutSection = find(document, "#left-out");
const leftOutRows = find(document, "#left-out-rows");

let titles: Title[] = [];
let chosen: Title | undefined;
let episodes: Episode[] = [];
let video: VideoFile | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchRequest: AbortController | undefined;

const getJSON = async <T>(path: string, signal?: AbortSignal): Promise<T | undefined> => {
  const response = await fetch(path, { signal }).catch(() => undefined);

  return response?.ok === true ? ((await response.json().catch(() => undefined)) as T) : undefined;
};

const titleText = ({ name, year }: Title) => (year === undefined ? name : `${name} (${year})`);

const count = (amount: number, noun: string) => `${amount} ${noun}${amount === 1 ? "" : "s"}`;

const optionFor = (title: Title, index: number) => {
  const option = document.createElement("li");

  option.id = `title-${index}`;
  option.dataset["index"] = String(index);
  option.setAttribute("role", "option");
  option.setAttribute("aria-selected", "false");
  option.append(titleText(title));

  if (title.type === "series") {
    const tag = document.createElement("span");

    tag.className = "tag";
    tag.textContent = "Series";
    option.append(tag);
  }

  return option;
};

const fillEpisodes = () => {
  const season = Number(seasonSelect.value);

  episodeSelect.replaceChildren(
    ...episodes
      .filter((each) => each.season === season)
      .map((each) => new Option(`${each.episode}. ${each.name}`, String(each.episode))),
  );
};

const loadEpisodes = async (id: string) => {
  const found = (await getJSON<Episode[]>(`/api/titles/${id}/episodes`)) ?? [];

  if (chosen?.id !== id) {
    return;
  }

  episodes = found;
  seasonSelect.replaceChildren(
    ...[...new Set(found.map((each) => each.season))].map(
      (season) => new Option(`Season ${season}`, String(season)),
    ),
  );
  fillEpisodes();
};

const pickTitle = (option: HTMLElement) => {
  const title = titles[Number(option.dataset["index"])];

  if (title === undefined) {
    return;
  }

  chosen = title;
  titleInput.value = titleText(title);
  titleCombo.setOpen(false);
  episodePick.hidden = title.type !== "series";
  checkError.textContent = "";

  if (title.type === "series") {
    seasonSelect.replaceChildren();
    episodeSelect.replaceChildren();
    void loadEpisodes(title.id);
  }
};

const titleCombo = combobox(titleInput, titleOptions, pickTitle);

const searchTitles = async () => {
  const query = titleInput.value.trim();

  searchRequest?.abort();

  if (query.length < minimumQueryLength) {
    titleOptions.replaceChildren();
    titleCombo.setOpen(false);

    return;
  }

  searchRequest = new AbortController();

  const { signal } = searchRequest;
  const response = await fetch(`/api/titles?q=${encodeURIComponent(query)}`, { signal }).catch(
    () => undefined,
  );
  const body: unknown = await response?.json().catch(() => undefined);

  if (signal.aborted) {
    return;
  }

  if (response?.ok !== true || !Array.isArray(body)) {
    checkError.textContent = errorOf(body);

    return;
  }

  const found: Title[] = body;

  checkError.textContent = "";
  titles = found;
  titleOptions.replaceChildren(...found.map(optionFor));
  titleCombo.setOpen(document.activeElement === titleInput);
};

const readVideo = async (file: File) => {
  video = undefined;
  dropName.textContent = file.name;
  dropDetail.textContent = "Reading…";

  const read = await videoHash(file).catch(() => undefined);

  if (fileInput.files?.[0] !== file) {
    return;
  }

  if (read === undefined) {
    dropDetail.textContent = "Could not read this file.";

    return;
  }

  const fingerprint = document.createElement("span");

  video = { ...read, name: file.name };
  fingerprint.className = "mono ink-2";
  fingerprint.textContent = read.hash;
  dropDetail.replaceChildren(
    "Fingerprint ",
    fingerprint,
    ` · ${sizeText(read.size)}. Read on your device, nothing was uploaded.`,
  );
  dropAction.textContent = "Choose another file";
};

const videoId = (title: Title) => {
  if (title.type === "movie") {
    return title.id;
  }

  return episodeSelect.value === ""
    ? undefined
    : `${title.id}:${seasonSelect.value}:${episodeSelect.value}`;
};

const shownRow = ({ lang, source, release, label, detail, playsFirst }: CheckRow) => {
  const row = clone("#shown-template");

  find(row, ".row-lang").textContent = lang;
  find(row, ".row-source").textContent = source;
  find(row, ".row-release").textContent = release ?? unknownRelease;
  find(row, ".row-icon").setAttribute("d", timingPaths[label] ?? notRetimedPath);
  find(row, ".row-label").textContent = label;
  find(row, ".row-detail").textContent = detail ?? "";
  find(row, ".row-first").hidden = playsFirst !== true;

  return row;
};

const leftOutRow = ({ lang, source, release, reason }: CheckRow) => {
  const row = clone("#left-out-template");

  find(row, ".row-title").textContent = `${lang} · ${source}`;
  find(row, ".row-release").textContent = release ?? unknownRelease;
  find(row, ".row-reason").textContent = reason ?? "";

  return row;
};

const timingSummary = (shown: CheckRow[]) => {
  const groups = Object.entries(Object.groupBy(shown, (row) => row.label));

  if (groups.length === 0) {
    return "No subtitle found";
  }

  return groups.map(([label, rows]) => `${rows?.length ?? 0} ${label.toLowerCase()}`).join(", ");
};

const showResults = ({ shown, leftOut, reference, searchedMs, sources }: CheckResult) => {
  find(document, "#summary-timing").textContent = timingSummary(shown);
  find(document, "#summary-reference").textContent = reference ?? "None found";
  find(document, "#summary-searched").textContent =
    `${count(sources, "source")} in ${(searchedMs / 1000).toFixed(1)} s`;
  find(document, "#shown-count").textContent = count(shown.length, "subtitle");
  find(document, "#left-out-count").textContent = count(leftOut.length, "subtitle");
  shownHead.hidden = shown.length === 0;
  shownRows.replaceChildren(...shown.map(shownRow));
  leftOutSection.hidden = leftOut.length === 0;
  leftOutRows.replaceChildren(...leftOut.map(leftOutRow));
  results.hidden = false;
  checkStatus.textContent = `${count(shown.length, "subtitle")} found, ${leftOut.length} left out.`;
};

titleInput.addEventListener("input", () => {
  titleOptions.replaceChildren();
  titleCombo.setOpen(false);
  chosen = undefined;
  episodePick.hidden = true;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void searchTitles(), searchDelayMs);
});

seasonSelect.addEventListener("change", fillEpisodes);

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];

  if (file !== undefined) {
    void readVideo(file);
  }
});

drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  drop.dataset["over"] = "";
});

drop.addEventListener("dragleave", () => {
  delete drop.dataset["over"];
});

drop.addEventListener("drop", (event) => {
  const files = event.dataTransfer?.files;

  event.preventDefault();
  delete drop.dataset["over"];

  if (files !== undefined && files.length > 0) {
    fileInput.files = files;
    fileInput.dispatchEvent(new Event("change"));
  }
});

form.addEventListener("submit", async (event) => {
  const title = chosen;
  const id = title === undefined ? undefined : videoId(title);
  const installURL = linkInput.value.trim();

  event.preventDefault();
  checkError.textContent = "";

  if (title === undefined) {
    checkError.textContent = "Pick a film or series from the list.";
    titleInput.focus();

    return;
  }

  if (id === undefined) {
    checkError.textContent = "Pick an episode.";
    episodeSelect.focus();

    return;
  }

  checkButton.disabled = true;
  checkStatus.textContent = "Checking every source…";

  const outcome = await postJSON("/api/check", {
    ...(installURL === "" ? {} : { installURL }),
    languages: fromLocales(navigator.languages).slice(0, maximumLanguages),
    type: title.type,
    id,
    ...(video === undefined
      ? {}
      : { videoHash: video.hash, videoSize: video.size, filename: video.name }),
  });

  checkButton.disabled = false;

  if ("error" in outcome) {
    checkStatus.textContent = "";
    checkError.textContent = outcome.error;

    return;
  }

  showResults(outcome.result as CheckResult);
});
