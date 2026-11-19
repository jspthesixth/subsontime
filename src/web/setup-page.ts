import { html } from "hono/html";
import { arrowIcon, earlierIcon, moreArrow, removeIcon, statusIcon } from "./icons.ts";
import { installedView, removeOldInstall } from "./installed-view.ts";
import { languageOptions } from "./language-options.ts";
import { layout } from "./layout.ts";

type AccountField = { name: string; label: string; type: string; autocomplete: string };

const apiKeyField: AccountField[] = [
  { name: "apiKey", label: "API key", type: "text", autocomplete: "off" },
];

const loginFields: AccountField[] = [
  { name: "username", label: "Username", type: "text", autocomplete: "username" },
  { name: "password", label: "Password", type: "password", autocomplete: "current-password" },
];

const accounts = [
  {
    kind: "opensubtitles",
    name: "OpenSubtitles",
    body: "Optional. Sign in so downloads use your own OpenSubtitles account (about 20 a day free, more with VIP).",
    add: "Sign in",
    saved: "Signed in",
    fields: loginFields,
  },
  {
    kind: "titlovi",
    name: "Titlovi.com",
    body: "Best for Croatian, Serbian, Bosnian, Slovenian and Macedonian.",
    add: "Add account",
    saved: "Added",
    fields: loginFields,
  },
  {
    kind: "subdl",
    name: "SubDL",
    body: "Large multilingual catalog.",
    add: "Add API key",
    saved: "Added",
    fields: apiKeyField,
  },
  {
    kind: "subsource",
    name: "SubSource",
    body: "Strong on new releases.",
    add: "Add API key",
    saved: "Added",
    fields: apiKeyField,
  },
];

const setupHead = (number: string, id: string, title: string, body: string) =>
  html`<div class="setup-head">
    <span class="eyebrow eyebrow-accent">${number}</span>
    <h2 class="h3" id="${id}">${title}</h2>
    <p class="small">${body}</p>
  </div>`;

const languagesBlock = html`<section class="setup-block" aria-labelledby="s1">
  ${setupHead("01", "s1", "Languages", "In order of preference. The first one turns on by itself.")}
  <div class="stack" style="gap: 20px;">
    <div
      class="row-wrap gap-8"
      role="list"
      aria-label="Chosen languages"
      id="chosen-languages"
    ></div>
    <div class="field combo" style="max-width: 420px;">
      <label class="label" for="lang-search">Add a language</label>
      <input
        id="lang-search"
        class="input"
        type="search"
        placeholder="Search, for example Português"
        autocomplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="false"
        aria-controls="lang-options"
      />
      <ul class="options" id="lang-options" role="listbox" aria-label="Languages" hidden>
        ${languageOptions.map(
          ({ code, name, search }) =>
            html`<li
              role="option"
              id="lang-${code}"
              data-code="${code}"
              data-search="${search}"
              aria-selected="false"
            >
              ${name}
            </li>`,
        )}
      </ul>
    </div>
    <label class="check">
      <input type="checkbox" id="best-only" checked />
      <span class="body"
        >Show only the best subtitle for each language. If it cannot be retimed, the next one takes
        its place.</span
      >
    </label>
  </div>
</section>`;

const accountRow = ({ kind, name, body, add, saved, fields }: (typeof accounts)[number]) =>
  html`<div class="list-row source" data-kind="${kind}" data-state="idle">
    <div class="list-main">
      <span class="h4" id="${kind}-name">${name}</span><span class="small">${body}</span>
    </div>
    <button
      type="button"
      class="btn btn-ghost btn-sm source-add"
      aria-expanded="false"
      aria-controls="${kind}-form"
    >
      ${add}
    </button>
    <div class="row-wrap gap-8 source-saved">
      <span class="status">${statusIcon}${saved}</span>
      <button type="button" class="btn-quiet source-remove" aria-label="Remove ${name}">
        Remove
      </button>
    </div>
    <form class="panel source-form" id="${kind}-form" aria-labelledby="${kind}-name">
      <div class="grid-2" style="gap: 16px;">
        ${fields.map(
          (field) =>
            html`<div class="field">
              <label class="label" for="${kind}-${field.name}">${field.label}</label
              ><input
                id="${kind}-${field.name}"
                name="${field.name}"
                class="input"
                type="${field.type}"
                autocomplete="${field.autocomplete}"
                spellcheck="false"
                required
              />
            </div>`,
        )}
      </div>
      <p class="hint error source-error" role="alert"></p>
      <div class="row-wrap between gap-12">
        <p class="hint">Checked against ${name} before it is saved.</p>
        <div class="row-wrap gap-8">
          <button type="button" class="btn btn-ghost btn-sm source-cancel">Cancel</button>
          <button type="submit" class="btn btn-light btn-sm">Check and save</button>
        </div>
      </div>
    </form>
  </div>`;

const sourcesBlock = (signIn: boolean) =>
  html`<section class="setup-block" aria-labelledby="s2">
    ${setupHead("02", "s2", "Sources", "Where to look. Accounts are used only to search and download for you, and are stored encrypted in your install link.")}
    <div class="stack gap-24">
      <div class="list" id="source-list">
        ${accounts.filter(({ kind }) => signIn || kind !== "opensubtitles").map(accountRow)}
      </div>
      <form class="field" id="addon-form">
        <label class="label" for="addon-url">Any Stremio subtitle addon</label>
        <div class="input-row">
          <input
            id="addon-url"
            class="input input-mono"
            type="url"
            placeholder="https://…/manifest.json"
            pattern="https?://.+/manifest\\.json"
            title="Must be an https manifest.json URL"
            autocomplete="off"
            required
          />
          <button type="submit" class="btn btn-ghost">Add source</button>
        </div>
        <p class="hint">
          Paste the link of a subtitle addon you already use. Its subtitles get retimed like all the
          others.
        </p>
      </form>
    </div>
  </section>`;

const timingOption = (
  value: string,
  title: ReturnType<typeof html>,
  body: string,
  checked: boolean,
) =>
  html`<label class="option">
    <input type="radio" name="timing" value="${value}" ${checked ? " checked" : ""} />
    <span class="stack" style="gap: 4px;"
      ><span class="h4">${title}</span><span class="small ink-2">${body}</span></span
    >
  </label>`;

const timingBlock = html`<section class="setup-block" aria-labelledby="s3">
  ${setupHead("03", "s3", "Timing", "How subtitles are lined up with your file.")}
  <div class="stack gap-24">
    <div class="stack gap-12" role="radiogroup" aria-labelledby="s3">
      ${timingOption(
        "auto",
        html`Automatic <span class="tag tag-accent" style="margin-left: 6px;">recommended</span>`,
        "A shared fix from Open Timings when one exists. Otherwise each subtitle is retimed against one made for your exact file. Works with any stream.",
        true,
      )}
      ${timingOption("off", html`Off`, "Subtitles arrive as the sources have them.", false)}
    </div>
    <div class="stack gap-12">
      <div class="list" id="stream-addon-list"></div>
      <form class="field" id="stream-addon-form">
        <label class="label" for="stream-addon"
          >Stream addons you play from
          <span class="tag tag-accent" style="margin-left: 6px;">best results</span></label
        >
        <div class="input-row">
          <input
            id="stream-addon"
            class="input input-mono"
            type="password"
            placeholder="https://…/manifest.json"
            pattern="https://.+/manifest\\.json"
            title="Must be an https manifest.json URL"
            autocomplete="off"
            spellcheck="false"
            required
          />
          <button type="submit" class="btn btn-ghost">Add stream addon</button>
        </div>
        <p class="hint">
          For the best results, paste the install link of each stream addon you play from. Subs On
          Time then finds the file you play and reads only its subtitle index, the times each line
          starts and ends, never its audio or video. For a file without subtitles inside, it reads
          two 64 KB pieces to identify the file. Without stream addons, it can only use timing
          someone else already found. <a href="/docs/privacy">What is read and kept</a>
        </p>
      </form>
    </div>
  </div>
</section>`;

type Switch = {
  id: string;
  labelId: string;
  title: string;
  body: string;
  checked: boolean;
  more?: ReturnType<typeof html>;
};

const switchRow = ({ id, labelId, title, body, checked, more }: Switch) =>
  html`<div class="list-row" style="align-items: flex-start; flex-wrap: nowrap;">
    <div class="list-main">
      <span class="h4" id="${labelId}">${title}</span><span class="small">${body}</span>${more}
    </div>
    <button
      type="button"
      role="switch"
      class="switch"
      id="${id}"
      aria-checked="${String(checked)}"
      aria-labelledby="${labelId}"
    >
      <span></span>
    </button>
  </div>`;

const extraSwitches: Switch[] = [
  {
    id: "hide-mismatches",
    labelId: "x-hide",
    title: "Hide subtitles made for another video",
    body: "When a subtitle’s dialogue does not line up with your file at all, it is for a different episode or film. It is left out, and when you share fixes it is flagged so it is left out for everyone once another connection agrees.",
    checked: true,
  },
  {
    id: "dialogue-only",
    labelId: "x-dialogue",
    title: "Dialogue only",
    body: "Also offer a copy without hearing-impaired tags like [music], (door slams) and speaker names.",
    checked: false,
  },
  {
    id: "foreign-parts",
    labelId: "x-forced",
    title: "Foreign parts only",
    body: "For films in your language: a subtitle that shows only the lines spoken in another language, when a source has one.",
    checked: false,
  },
  {
    id: "dual",
    labelId: "x-dual",
    title: "Dual subtitles",
    body: "Your first language on top, a second one below, both timed to the same reference so they never drift apart.",
    checked: false,
    more: html`<div class="row-wrap gap-12" id="dual-row" style="padding-top: 12px;" hidden>
      <label class="small ink-2" for="dual-lang">Second language</label>
      <select id="dual-lang" class="select">
        ${languageOptions.map(({ code, name }) => html`<option value="${code}">${name}</option>`)}
      </select>
    </div>`,
  },
  {
    id: "source-in-language",
    labelId: "x-source",
    title: "Show the source in the language name",
    body: "For TV apps that only show the language. Stremio then stops picking your language by itself.",
    checked: false,
  },
];

const extrasBlock = html`<section class="setup-block" aria-labelledby="s4">
  ${setupHead("04", "s4", "Extras", "Things no other Stremio addon does. All optional.")}
  <div class="list">${extraSwitches.map(switchRow)}</div>
</section>`;

const sharingSwitches: Switch[] = [
  {
    id: "use-shared",
    labelId: "o-use",
    title: "Use shared fixes",
    body: "Apply a fix others confirmed for your exact file, and leave out subtitles they flagged for another video.",
    checked: true,
  },
  {
    id: "share",
    labelId: "o-share",
    title: "Share the fixes made for me",
    body: "Send the result back: the new time of each line, with fingerprints. Never subtitle text, your accounts or your address.",
    checked: true,
  },
];

const sharingBlock = html`<section class="setup-block" aria-labelledby="s5">
  <div class="setup-head">
    <span class="eyebrow eyebrow-accent">05</span>
    <h2 class="h3" id="s5">Open Timings</h2>
    <p class="small">The shared record of fixes.</p>
    <a class="more" href="/timings">What it keeps${moreArrow}</a>
  </div>
  <div class="list">${sharingSwitches.map(switchRow)}</div>
</section>`;

const installBar = html`<div class="install-bar" id="install-bar">
  <div class="wrap install-bar-in">
    <div class="stack" style="gap: 2px;">
      <span class="h4">Ready to install</span>
      <span class="small" id="install-summary"></span>
      <span class="small" id="edit-note" hidden>${removeOldInstall}</span>
      <span class="small error" id="install-error" role="alert"></span>
    </div>
    <div class="row-wrap gap-12" style="flex: 0 1 auto;">
      <button
        type="button"
        class="btn btn-ghost"
        id="edit-install"
        aria-expanded="false"
        aria-controls="edit-form"
      >
        Edit an install
      </button>
      <button type="button" class="btn btn-primary" id="install">
        Install in Stremio ${arrowIcon}
      </button>
    </div>
    <form class="field edit-form" id="edit-form" hidden>
      <label class="label" for="edit-link">Your install link</label>
      <div class="input-row">
        <input
          id="edit-link"
          class="input input-mono"
          type="url"
          autocomplete="off"
          spellcheck="false"
          required
        />
        <button type="submit" class="btn btn-light">Open</button>
      </div>
    </form>
  </div>
</div>`;

const templates = html`<template id="chip-template"
    ><span class="chip" role="listitem"
      ><span class="n"></span><span class="chip-name"></span
      ><button type="button" class="x move">${earlierIcon}</button
      ><button type="button" class="x remove">${removeIcon}</button></span
    ></template
  >
  <template id="addon-template"
    ><div class="list-row addon-row">
      <div class="list-main">
        <span class="h4 addon-host"></span><span class="small mono addon-url"></span>
      </div>
      <button type="button" class="btn-quiet addon-remove">Remove</button>
    </div></template
  >
  <template id="installed-template">${installedView}</template>`;

const contentOf = (openSubtitlesSignIn: boolean) =>
  html`<main class="wrap" id="setup" style="padding-top: 72px; padding-bottom: 96px;">
      <div class="stack gap-16 measure" style="padding-bottom: 56px;">
        <p class="eyebrow eyebrow-accent">Stremio addon</p>
        <h1 class="h2" id="page-title" tabindex="-1">Set up Subs On Time</h1>
        <p class="lede">Only the language is required. Everything else has a default that works.</p>
      </div>

      <div class="stack gap-48">
        ${languagesBlock} ${sourcesBlock(openSubtitlesSignIn)} ${timingBlock} ${extrasBlock}
        ${sharingBlock}
      </div>
    </main>
    ${installBar} ${templates}`;

export const setupPage = (analytics: boolean | undefined, openSubtitlesSignIn: boolean) =>
  layout({
    analytics,
    title: "Set up Subs On Time for Stremio",
    description:
      "Choose your subtitle languages and sources, then install Subs On Time in Stremio.",
    active: "stremio",
    content: contentOf(openSubtitlesSignIn),
    scripts: ["setup"],
  });
