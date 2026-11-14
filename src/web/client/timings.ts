import type { VideoTimings } from "../../timings/confirm.ts";
import { clone, find } from "./lib/dom.ts";
import { fixRows, type FixRowView } from "./lib/fix-rows.ts";
import { errorOf } from "./lib/post-json.ts";
import { sizeText } from "./lib/size-text.ts";
import { videoHash } from "./lib/video-hash.ts";

const fingerprintPattern = /^([0-9a-f]{16}):([1-9]\d{0,15})$/;
const fingerprintMessage =
  "Paste the fingerprint as hash:size, for example 8e245d9679d31e12:4703284372.";
const unreadableMessage = "Could not read this file.";

const form = find<HTMLFormElement>(document, "#lookup-form");
const input = find<HTMLInputElement>(document, "#fingerprint");
const fileInput = find<HTMLInputElement>(document, "#lookup-file");
const lookUpButton = find<HTMLButtonElement>(document, "#lookup");
const error = find(document, "#lookup-error");
const result = find(document, "#lookup-result");
const nameText = find(document, "#lookup-name");
const keyText = find(document, "#lookup-key");
const countText = find(document, "#lookup-count");
const head = find(document, "#lookup-head");
const rows = find(document, "#lookup-rows");
const empty = find(document, "#lookup-empty");

let fileName: string | undefined;

const rowFor = ({ subtitle, lines, timedBy, agreement, status, accent }: FixRowView) => {
  const row = clone("#fix-row-template");
  const tag = find(row, ".row-status");

  find(row, ".row-subtitle").textContent = subtitle;
  find(row, ".row-lines").textContent = lines;
  find(row, ".row-timed-by").textContent = timedBy;
  find(row, ".row-agreement").textContent = agreement;
  tag.textContent = status;
  tag.classList.toggle("tag-accent", accent);

  return row;
};

const show = (hash: string, size: number, timings: VideoTimings) => {
  const listed = fixRows(timings);

  nameText.textContent = fileName ?? hash;
  keyText.textContent = `${hash} · ${sizeText(size)}`;
  countText.textContent = `${timings.fixes.length} ${timings.fixes.length === 1 ? "fix" : "fixes"} · ${timings.hidden.length} flagged`;
  rows.replaceChildren(...listed.map(rowFor));
  head.hidden = listed.length === 0;
  empty.hidden = listed.length > 0;
  result.hidden = false;
};

const lookUp = async () => {
  const [, hash, size] = fingerprintPattern.exec(input.value.trim().toLowerCase()) ?? [];

  error.textContent = "";

  if (hash === undefined || size === undefined) {
    error.textContent = fingerprintMessage;
    input.focus();

    return;
  }

  lookUpButton.disabled = true;

  const response = await fetch(`/api/v1/fixes?video=${hash}:${size}`).catch(() => undefined);
  const body: unknown = await response?.json().catch(() => undefined);

  lookUpButton.disabled = false;

  if (response?.ok !== true) {
    error.textContent = errorOf(body);

    return;
  }

  show(hash, Number(size), body as VideoTimings);
};

const readFile = async (file: File) => {
  error.textContent = "";

  const read = await videoHash(file).catch(() => undefined);

  if (read === undefined) {
    error.textContent = unreadableMessage;

    return;
  }

  fileName = file.name;
  input.value = `${read.hash}:${read.size}`;
  await lookUp();
};

input.addEventListener("input", () => {
  fileName = undefined;
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void lookUp();
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];

  if (file !== undefined) {
    void readFile(file);
  }
});

form.addEventListener("dragover", (event) => {
  event.preventDefault();
  form.dataset["over"] = "";
});

form.addEventListener("dragleave", () => {
  delete form.dataset["over"];
});

form.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files[0];

  event.preventDefault();
  delete form.dataset["over"];

  if (file !== undefined) {
    void readFile(file);
  }
});
