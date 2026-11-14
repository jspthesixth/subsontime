import { html } from "hono/html";
import { arrowIcon, moreArrow, noIcon, yesIcon } from "./icons.ts";
import { layout } from "./layout.ts";

const problems = [
  { title: "Starts late", body: "Every line two seconds behind the voice.", fix: "offset -2.00 s" },
  {
    title: "Drifts",
    body: "Right at the start, minutes off by the end. Made for 25 fps, you play 23.976.",
    fix: "speed 25 to 23.976",
  },
  {
    title: "Jumps after a scene",
    body: "Your cut has a scene theirs does not, or a recap at the start.",
    fix: "2 cuts found",
  },
  {
    title: "Wrong video",
    body: "Uploaded for another episode or another film. It never reaches your menu.",
    fix: "hidden",
  },
];

const cues = [
  { left: 6, width: 14 },
  { left: 26, width: 22 },
  { left: 55, width: 9 },
  { left: 70, width: 20 },
];

const wrongCues = [
  { left: 11, width: 14 },
  { left: 32, width: 22 },
  { left: 62, width: 9 },
  { left: 78, width: 20 },
];

const kept = [
  "Timing fixes: the new start and end of each line",
  "Fingerprints of video files and subtitles",
  "Which subtitles belong to another video, and which were reported",
];
const neverKept = [
  "Subtitle text",
  "Your accounts, keys or passwords",
  "Who you are, or what you watched",
];

const flowNodes = [
  {
    who: "Someone with the file",
    title: "The addon retimes a subtitle for it",
    body: "Against a subtitle made for that exact file, found by its fingerprint.",
    accent: false,
  },
  {
    who: "Open Timings",
    title: "Keeps the fix as times and fingerprints",
    body: "The new start and end of each line. Confirmed once two connections agree.",
    accent: true,
  },
  {
    who: "You, streaming the same file",
    title: "Stremio gets it before the first line",
    body: "No waiting, no delay buttons. Our server never reads your video.",
    accent: false,
  },
];

const flowArrow = html`<div class="flow-arrow" aria-hidden="true">
  <svg width="28" height="16" viewBox="0 0 28 16">
    <path d="M1 8h24M19 2l6 6-6 6" stroke="currentColor" stroke-width="1.6" fill="none"></path>
  </svg>
</div>`;

const flowNode = ({ who, title, body, accent }: (typeof flowNodes)[number]) =>
  html`<div class="${accent ? "flow-node flow-node-accent" : "flow-node"}">
    <span class="${accent ? "mono accent" : "mono ink-3"}">${who}</span>
    <h3 class="h4">${title}</h3>
    <p class="small">${body}</p>
  </div>`;

const timelineBar = (className: string, spans: { left: number; width: number }[]) =>
  html`<div class="tl-bar">
    ${spans.map(
      ({ left, width }) =>
        html`<span class="${className}" style="left: ${left}%; width: ${width}%;"></span>`,
    )}
  </div>`;

const content = html`<main>
  <section class="wrap" style="padding-top: 96px; padding-bottom: 56px;">
    <div class="stack gap-32">
      <p class="eyebrow">00:00:01,000 --&gt; 00:00:04,200</p>
      <h1 class="h1">Subtitles that fit the file you are playing.</h1>
      <p class="lede">
        Subs On Time finds subtitles in every source and retimes each one to your exact video. Every
        fix is shared, so the next person with the same file gets it before the first line.
      </p>
      <div class="row-wrap gap-12">
        <a class="btn btn-primary btn-wide-mobile" href="/stremio">Add to Stremio ${arrowIcon}</a>
      </div>
    </div>
  </section>

  <section class="wrap" aria-label="A subtitle before and after" style="padding-bottom: 24px;">
    <div class="panel panel-pad tl">
      <div class="row-wrap between gap-8">
        <span class="mono ink-3">Example.Movie.2024.1080p.WEB-DL-GROUP.mkv</span>
        <span class="mono ink-3">00:41:10 - 00:41:30</span>
      </div>
      <div class="tl-row">
        <span class="small">Speech in your video</span>
        ${timelineBar("cue-speech", cues)}
      </div>
      <div class="tl-row">
        <span class="small">Subtitle as downloaded, made for a 25 fps release</span>
        ${timelineBar("cue-wrong", wrongCues)}
      </div>
      <div class="tl-row">
        <span class="small ink">With Subs On Time: speed 25 to 23.976, then 1.20 s earlier</span>
        ${timelineBar("cue-right", cues)}
      </div>
    </div>
  </section>

  <section class="wrap section">
    <div class="stack gap-48">
      <div class="stack gap-16 measure">
        <p class="eyebrow eyebrow-accent">What goes wrong</p>
        <h2 class="h2">Four ways a subtitle misses. All four fixed.</h2>
      </div>
      <div class="grid-4">
        ${problems.map(
          ({ title, body, fix }) =>
            html`<div class="step">
              <h3 class="h4">${title}</h3>
              <p class="body">${body}</p>
              <span class="mono accent">${fix}</span>
            </div>`,
        )}
      </div>
    </div>
  </section>

  <section class="band">
    <div class="wrap section">
      <div class="stack gap-48">
        <div class="stack gap-16 measure">
          <p class="eyebrow eyebrow-accent">Open Timings</p>
          <h2 class="h2">Fixed once. Fixed for everyone.</h2>
          <p class="body">
            The torrent you stream is often the very file someone else downloaded. Their fix becomes
            yours, matched by the file's fingerprint.
          </p>
        </div>
        <div class="flow">
          ${flowNodes.flatMap((node, index) => (index === 0 ? [flowNode(node)] : [flowArrow, flowNode(node)]))}
        </div>
        <a class="more" href="/timings">How Open Timings works${moreArrow}</a>
      </div>
    </div>
  </section>

  <section class="wrap section">
    <div class="stack gap-48">
      <div class="stack gap-16 measure">
        <p class="eyebrow eyebrow-accent">Where you watch</p>
        <h2 class="h2">Made for Stremio</h2>
      </div>
      <div>
        <div class="where">
          <h3 class="h3">Stremio</h3>
          <p class="body">
            An addon. One minute to set up, then it works on desktop, phone and TV.
          </p>
          <a class="btn btn-primary btn-sm" href="/stremio">Add to Stremio</a>
        </div>
      </div>
    </div>
  </section>

  <section class="band">
    <div class="wrap section">
      <div class="stack gap-48">
        <div class="stack gap-16 measure">
          <p class="eyebrow eyebrow-accent">Open by default</p>
          <h2 class="h2">Open source. Open data. Nothing about you.</h2>
        </div>
        <div class="compare">
          <div class="stack">
            <h3 class="h4 compare-head">What Open Timings keeps</h3>
            ${kept.map((item) => html`<div class="mark-yes">${yesIcon}<span class="body">${item}</span></div>`)}
          </div>
          <div class="stack">
            <h3 class="h4 compare-head">What it never keeps</h3>
            ${neverKept.map((item) => html`<div class="mark-no">${noIcon}<span class="body">${item}</span></div>`)}
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="wrap section">
    <div class="stack gap-24" style="align-items: flex-start;">
      <p class="eyebrow">00:00:04,200 --&gt; 00:00:06,000</p>
      <h2 class="h2" style="max-width: 14ch;">Your next subtitle, on time.</h2>
      <a class="btn btn-primary btn-wide-mobile" href="/stremio">Add to Stremio ${arrowIcon}</a>
    </div>
  </section>
</main>`;

export const homePage = () =>
  layout({
    title: "Subs On Time",
    description:
      "Subtitles that fit the file you are playing. A Stremio addon that retimes every subtitle to your exact video.",
    active: "home",
    content,
  });
