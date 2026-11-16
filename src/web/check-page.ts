import { html } from "hono/html";
import type { reportReasons } from "../timings/api.ts";
import { layout } from "./layout.ts";

const reasonLabels: Record<(typeof reportReasons)[number], string> = {
  "machine-translated": "Machine translated",
  "wrong-language": "Wrong language",
  "lines-missing": "Lines missing",
  "timing-off": "Timing still off",
  "broken-characters": "Broken characters",
};

const fileIcon = html`<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
  <rect
    x="4"
    y="3"
    width="20"
    height="22"
    rx="3"
    stroke="#9A988F"
    stroke-width="1.5"
    fill="none"
  ></rect>
  <path d="M9 10h10M9 14h10M9 18h6" stroke="#9A988F" stroke-width="1.5"></path>
</svg>`;

const form = html`<form class="stack gap-24" id="check-form" novalidate>
  <div class="grid-2" style="gap: 24px;">
    <div class="stack gap-16">
      <div class="field combo">
        <label class="label" for="title">Film or episode</label>
        <input
          id="title"
          class="input"
          type="search"
          placeholder="Search, for example The Shawshank Redemption"
          autocomplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="false"
          aria-controls="title-options"
          aria-describedby="title-hint"
        />
        <ul
          class="options"
          id="title-options"
          role="listbox"
          aria-label="Films and series"
          hidden
        ></ul>
        <p class="hint" id="title-hint">
          Found in Stremio's catalog. For a series, pick the episode.
        </p>
      </div>
      <div class="row-wrap gap-12" id="episode-pick" hidden>
        <div class="field">
          <label class="label" for="season">Season</label>
          <select id="season" class="select"></select>
        </div>
        <div class="field" style="flex: 1 1 200px;">
          <label class="label" for="episode">Episode</label>
          <select id="episode" class="select"></select>
        </div>
      </div>
    </div>
    <div class="field">
      <label class="label" for="link">Your install link</label>
      <input
        id="link"
        class="input input-mono"
        type="text"
        placeholder="https://…/manifest.json"
        autocomplete="off"
        spellcheck="false"
        aria-describedby="link-hint"
      />
      <p class="hint" id="link-hint">So the check uses your languages and sources. Optional.</p>
    </div>
  </div>
  <label class="drop" id="drop">
    ${fileIcon}
    <span class="h4 drop-name" id="drop-name">Drop the video file here</span>
    <span class="small" id="drop-detail">Optional. Read on your device, nothing is uploaded.</span>
    <span class="btn-quiet" id="drop-action">Choose a file</span>
    <input type="file" id="video-file" class="drop-input" />
  </label>
  <p class="hint error" id="check-error" role="alert"></p>
  <div class="row-wrap gap-16">
    <button type="submit" class="btn btn-primary btn-wide-mobile" id="check">Check</button>
    <p class="small" id="check-status" role="status" aria-live="polite"></p>
  </div>
</form>`;

const results = html`<div id="results" hidden>
  <section class="panel panel-pad" aria-label="Summary" style="margin-top: 48px;">
    <div class="kv">
      <div><span class="small">Timing</span><span class="h4" id="summary-timing"></span></div>
      <div><span class="small">Reference</span><span class="h4" id="summary-reference"></span></div>
      <div><span class="small">Searched</span><span class="h4" id="summary-searched"></span></div>
    </div>
  </section>

  <section aria-labelledby="shown" style="padding-top: 56px;">
    <div class="row-wrap between gap-12" style="padding-bottom: 16px;">
      <h2 class="h3" id="shown">What we found</h2>
      <span class="small" id="shown-count"></span>
    </div>
    <p class="hint" id="report-hint" style="padding-bottom: 16px;" hidden>
      To report a subtitle, check again with the video file. Reports are kept per file.
    </p>
    <div class="sub-row sub-head" id="shown-head" aria-hidden="true">
      <span>Language</span><span>Source</span><span>Made for</span><span>Timing</span><span></span>
    </div>
    <div id="shown-rows"></div>
  </section>

  <section aria-labelledby="hidden" id="left-out" style="padding-top: 56px;">
    <div class="row-wrap between gap-12" style="padding-bottom: 16px;">
      <h2 class="h3" id="hidden">Left out</h2>
      <span class="small" id="left-out-count"></span>
    </div>
    <div class="list" id="left-out-rows"></div>
  </section>
</div>`;

const reasons = Object.entries(reasonLabels).map(
  ([value, label], index) =>
    html`<label class="tag" style="padding: 8px 14px; font-size: 13px; cursor: pointer;"
      ><input
        type="radio"
        name="reason"
        value="${value}"
        ${index === 0 ? "checked" : ""}
        style="accent-color: #F5D547;"
      />${label}</label
    >`,
);

const templates = html`<template id="shown-template"
    ><div>
      <div class="sub-row">
        <div><span class="sub-k">Language</span><span class="h4 row-lang"></span></div>
        <div><span class="sub-k">Source</span><span class="body row-source"></span></div>
        <div class="sub-wide">
          <span class="sub-k">Made for</span><span class="mono ink-2 row-release"></span>
        </div>
        <div class="sub-wide">
          <span class="sub-k">Timing</span>
          <span class="status"
            ><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path class="row-icon" stroke="#F5D547" stroke-width="1.8" fill="none"></path></svg
            ><span class="row-label"></span
          ></span>
          <span class="mono ink-3 row-detail" style="display: block; padding-top: 2px;"></span>
          <span class="tag tag-accent row-first" style="margin-top: 8px;" hidden>Plays first</span>
        </div>
        <div class="sub-wide row-wrap gap-8">
          <button type="button" class="btn-quiet row-report" aria-expanded="false" hidden>
            Report
          </button>
        </div>
      </div>
      <div
        class="panel row-panel"
        style="margin: 0 0 16px; padding: 20px; display: flex; flex-direction: column; gap: 16px; border-color: #55544D;"
        hidden
      >
        <span class="h4 row-question"></span>
        <div class="row-wrap gap-8" role="radiogroup" aria-label="Reason">${reasons}</div>
        <div class="row-wrap between gap-12">
          <p class="hint">
            Reports are anonymous. After a few, this subtitle stops showing for everyone.
          </p>
          <div class="row-wrap gap-8">
            <button type="button" class="btn btn-ghost btn-sm row-cancel">Cancel</button>
            <button type="button" class="btn btn-light btn-sm row-send">Send report</button>
          </div>
        </div>
        <p class="hint error row-error" role="alert"></p>
        <p class="small row-sent" role="status" aria-live="polite"></p>
      </div></div
  ></template>
  <template id="left-out-template"
    ><div class="list-row">
      <div class="list-main">
        <span class="h4 row-title"></span><span class="mono ink-3 row-release"></span>
      </div>
      <span class="status status-muted" style="flex: 1 1 260px;"
        ><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="#9A988F" stroke-width="1.5" fill="none"></circle>
          <path class="row-icon" stroke="#9A988F" stroke-width="1.5"></path></svg
        ><span class="row-reason"></span
      ></span></div
  ></template>`;

const content = html`<main class="wrap" style="padding-top: 72px; padding-bottom: 112px;">
    <div class="stack gap-16 measure" style="padding-bottom: 48px;">
      <p class="eyebrow eyebrow-accent">Check a file</p>
      <h1 class="h2">See every subtitle before you press play.</h1>
      <p class="lede">
        What each source has for one video, how each subtitle would be timed, and what was left out
        and why.
      </p>
    </div>
    ${form} ${results}
  </main>
  ${templates}`;

export const checkPage = (analytics?: boolean) =>
  layout({
    analytics,
    title: "Check a file with Subs On Time",
    description:
      "See what every source has for one video, how each subtitle would be timed, and what was left out and why.",
    active: "check",
    content,
    scripts: ["check"],
  });
