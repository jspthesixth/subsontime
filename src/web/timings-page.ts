import { html } from "hono/html";
import type { StoreStats } from "../timings/db.ts";
import { arrowIcon } from "./icons.ts";
import { layout } from "./layout.ts";

const numberFormat = new Intl.NumberFormat("en");

const statLabels: [keyof StoreStats, string][] = [
  ["fixes", "timing fixes"],
  ["confirmed", "files with fixes from two or more connections"],
  ["videos", "video files covered"],
  ["hidden", "files with a subtitle flagged for the wrong video"],
];

const steps = [
  {
    title: "Someone fixes a subtitle",
    body: "The Stremio addon retimes it against a subtitle made for the same file, then sends the new time of each line with two fingerprints.",
  },
  {
    title: "Others agree",
    body: "Confirmed once two fixes from different connections agree within 100 ms, with one from audio or two different references. Outliers are dropped.",
  },
  {
    title: "Everyone gets it",
    body: "The next person with the same file and the same subtitle gets the fix before the first line.",
  },
];

const columns = [
  { name: "Subtitle", className: "mono ink-2 row-subtitle" },
  { name: "Lines", className: "h4 row-lines" },
  { name: "Timed by", className: "body row-timed-by" },
  { name: "Agreement", className: "body row-agreement" },
  { name: "Status", className: "tag row-status" },
];

const statText = (stats: StoreStats | undefined, key: keyof StoreStats) =>
  stats === undefined ? "-" : numberFormat.format(stats[key]);

const statsBlock = (stats: StoreStats | undefined) =>
  html`<section class="wrap" aria-label="In numbers" style="padding-bottom: 96px;">
    <div class="grid-4">
      ${statLabels.map(
        ([key, label]) =>
          html`<div class="stat">
            <span class="stat-n">${statText(stats, key)}</span><span class="small">${label}</span>
          </div>`,
      )}
    </div>
    ${
      stats === undefined
        ? html`<p class="small" style="padding-top: 24px;">Numbers are unavailable right now.</p>`
        : ""
    }
  </section>`;

const lookUpBlock = html`<section class="band" aria-labelledby="look-up">
  <div class="wrap section">
    <div class="stack gap-32">
      <div class="stack gap-12 measure">
        <h2 class="h2" id="look-up">Look up a file</h2>
        <p class="body">
          Drop a video, or paste its fingerprint. The file is read on your device and never
          uploaded.
        </p>
      </div>
      <form class="stack gap-12" id="lookup-form" style="max-width: 760px;" novalidate>
        <div class="input-row">
          <input
            class="input input-mono"
            id="fingerprint"
            type="text"
            aria-label="Fingerprint"
            placeholder="8e245d9679d31e12:4703284372"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="lookup-error"
          />
          <label class="btn btn-ghost file-btn"
            >Choose a file<input type="file" id="lookup-file" class="drop-input"
          /></label>
          <button type="submit" class="btn btn-primary" id="lookup">Look up</button>
        </div>
        <p class="hint error" id="lookup-error" role="alert"></p>
      </form>
      <div class="panel" id="lookup-result" hidden>
        <div
          class="row-wrap between gap-12"
          style="padding: 20px 24px; border-bottom: 1px solid var(--line);"
        >
          <div class="stack" style="gap: 2px;">
            <span class="h4 drop-name" id="lookup-name"></span
            ><span class="mono ink-3" id="lookup-key"></span>
          </div>
          <span class="small" id="lookup-count"></span>
        </div>
        <div style="padding: 4px 24px 8px;">
          <div role="table" aria-label="Fixes for this file" id="lookup-table">
            <div role="rowgroup">
              <div class="sub-row fixes sub-head" role="row">
                ${columns.map(({ name }) => html`<span role="columnheader">${name}</span>`)}
              </div>
            </div>
            <div role="rowgroup" id="lookup-rows"></div>
          </div>
          <p class="body" id="lookup-empty" style="padding: 20px 0;" hidden>
            No fixes for this file yet.
          </p>
        </div>
      </div>
    </div>
  </div>
</section>`;

const stepsBlock = html`<section class="wrap section">
  <div class="stack gap-48">
    <div class="stack gap-12 measure">
      <h2 class="h2">How a fix becomes confirmed</h2>
      <p class="body">
        One submission is a hint. Agreement makes it the answer.
        <a class="accent" href="/docs/open-timings">The exact rules</a>.
      </p>
    </div>
    <div class="steps">
      ${steps.map(
        ({ title, body }, index) =>
          html`<div class="step">
            <span class="eyebrow eyebrow-accent">0${index + 1}</span>
            <h3 class="h4">${title}</h3>
            <p class="body">${body}</p>
          </div>`,
      )}
    </div>
  </div>
</section>`;

const privacyBlock = html`<section class="band">
  <div class="wrap section">
    <div class="compare">
      <div class="stack gap-16">
        <h2 class="h3">Fingerprints, not files</h2>
        <p class="body">
          A video's fingerprint comes from its size and its first and last 64 KB, and cannot be
          turned back into the video. A subtitle's is a short code for the words of each line, so
          the same subtitle from two sites, or in two encodings, is recognized as one.
        </p>
        <p class="body">
          Very short common lines, like Yes, can be guessed from their fingerprint; longer lines
          cannot.
        </p>
      </div>
      <div class="stack gap-16">
        <h2 class="h3">No one to identify</h2>
        <p class="body">
          Submissions carry no account and no address. A daily-changing code makes it harder for one
          connection to confirm its own fix or hide a subtitle; it cannot be traced back after that
          day.
        </p>
        <p class="body">Credentials stay in your own install link and never reach Open Timings.</p>
      </div>
    </div>
  </div>
</section>`;

const apiBlock = (dumpDate: string | undefined) =>
  html`<section id="api" class="wrap section">
    <div class="stack gap-32">
      <div class="stack gap-12 measure">
        <h2 class="h2">Use the data</h2>
        <p class="body">
          Everything here is open: query it from your own player or tool, or take the whole record.
        </p>
      </div>
      <div class="grid-2">
        <a class="int-card" href="/docs/api">
          <span class="int-head">
            <span class="stack" style="gap: 2px;">
              <span class="h4">API</span><span class="small">JSON, no key, any origin</span>
            </span>
          </span>
          <span class="doc-endpoint"
            ><span class="doc-method doc-method-get">GET</span
            ><code>/api/v1/fixes?video={hash}:{size}</code></span
          >
          <span class="btn btn-ghost btn-sm int-more">Read the API ${arrowIcon}</span>
        </a>
        <a class="int-card" href="/docs/data">
          <span class="int-head">
            <span class="stack" style="gap: 2px;">
              <span class="h4">Daily download</span
              ><span class="small">Gzipped JSON Lines, CC0-1.0</span>
              ${dumpDate === undefined ? "" : html`<span class="small">Updated ${dumpDate}</span>`}
            </span>
          </span>
          <span class="body">Every file, every fix and every hidden subtitle, in one file.</span>
          <span class="btn btn-ghost btn-sm int-more">See the format ${arrowIcon}</span>
        </a>
      </div>
      <div class="row-wrap gap-12">
        <a class="btn btn-ghost" href="/api/v1/dump">Download the data</a>
      </div>
    </div>
  </section>`;

const templates = html`<template id="fix-row-template"
  ><div class="sub-row fixes" role="row">
    ${columns.map(
      ({ name, className }) =>
        html`<div role="cell">
          <span class="sub-k" aria-hidden="true">${name}</span><span class="${className}"></span>
        </div>`,
    )}
  </div></template
>`;

const content = (stats: StoreStats | undefined, dumpDate: string | undefined) =>
  html`<main>
      <section class="wrap" style="padding-top: 80px; padding-bottom: 64px;">
        <div class="stack gap-24">
          <p class="eyebrow eyebrow-accent">Open Timings</p>
          <h1 class="h1" style="max-width: 13ch;">The shared record of subtitle fixes.</h1>
          <p class="lede">
            How to fix a subtitle's timing, file by file, found once and used by everyone. Times and
            fingerprints only: no subtitle text, no accounts, no addresses.
          </p>
        </div>
      </section>
      ${statsBlock(stats)} ${lookUpBlock} ${stepsBlock} ${privacyBlock} ${apiBlock(dumpDate)}
    </main>
    ${templates}`;

export const timingsPage = (
  stats: StoreStats | undefined,
  dumpDate: string | undefined,
  analytics?: boolean,
) =>
  layout({
    analytics,
    title: "Open Timings",
    description:
      "The shared record of subtitle fixes: how to fix a subtitle's timing, file by file, found once and used by everyone.",
    active: "timings",
    content: content(stats, dumpDate),
    scripts: ["timings"],
  });
