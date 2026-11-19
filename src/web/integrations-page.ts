import { html } from "hono/html";
import { guideIcons, arrowIcon, noIcon, yesIcon } from "./icons.ts";
import { layout } from "./layout.ts";

type Integration = {
  slug: string;
  name: string;
  kind: string;
  body: string;
  action: string;
  runsOn: string;
  audio: boolean;
};

const integrations: Integration[] = [
  {
    slug: "stremio",
    name: "Stremio",
    kind: "Addon",
    body: "Subtitles for whatever you stream, retimed to the stream. Works with every debrid service.",
    runsOn: "The Subs On Time server",
    action: "Set up",
    audio: false,
  },
  {
    slug: "bazarr",
    name: "Sonarr and Radarr",
    kind: "Bazarr post-processing",
    body: "After Bazarr downloads a subtitle for your library, it gets fitted to the file and its soundtrack.",
    runsOn: "Your machine, next to the file",
    action: "Set up",
    audio: true,
  },
  {
    slug: "bazarr-plus",
    name: "Bazarr+",
    kind: "Provider",
    body: "A Provider Hub provider. Bazarr+ searches Subs On Time and gets subtitles already fitted.",
    runsOn: "The Subs On Time server",
    action: "Set up",
    audio: false,
  },
  {
    slug: "jellyfin",
    name: "Jellyfin",
    kind: "Plugin",
    body: "Subtitle search for your Jellyfin library, with shared fixes applied file by file.",
    runsOn: "The Subs On Time server",
    action: "Set up",
    audio: false,
  },
  {
    slug: "cli",
    name: "Any player",
    kind: "Command line",
    body: "For mpv, VLC, Kodi or a folder of files. Writes a fitted subtitle next to each video.",
    runsOn: "Your machine, next to the file",
    action: "Set up",
    audio: true,
  },
  {
    slug: "api",
    name: "Build your own",
    kind: "API",
    body: "Open Timings has a public API and a daily download. Plug it into any player or tool.",
    runsOn: "",
    action: "Read the API",
    audio: false,
  },
];

const card = ({ slug, name, kind, body, action }: Integration) =>
  html`<a class="int-card" href="/docs/${slug}">
    <span class="int-head">
      <span class="int-glyph" aria-hidden="true">${guideIcons[slug]}</span>
      <span class="stack" style="gap: 2px;">
        <span class="h4">${name}</span><span class="small">${kind}</span>
      </span>
    </span>
    <span class="body">${body}</span>
    <span class="btn btn-ghost btn-sm int-more">${action} ${arrowIcon}</span>
  </a>`;

const comparison = html`<section class="wrap section-tight" aria-labelledby="which">
  <div class="stack gap-32">
    <div class="stack gap-12 measure">
      <h2 class="h3" id="which">Which one?</h2>
      <p class="body">
        Every one gets fixes others shared for your exact file. The ones that run next to the file
        can also listen to its soundtrack, which fixes subtitles no other subtitle can.
      </p>
    </div>
    <div class="doc-table-wrap">
      <table class="doc-table int-table">
        <thead>
          <tr>
            <th scope="col">Integration</th>
            <th scope="col">Timing runs on</th>
            <th scope="col">Syncs to the soundtrack</th>
          </tr>
        </thead>
        <tbody>
          ${integrations
            .filter(({ slug }) => slug !== "api")
            .map(
              ({ slug, name, runsOn, audio }) =>
                html`<tr>
                  <td><a href="/docs/${slug}">${name}</a></td>
                  <td>${runsOn}</td>
                  <td>
                    <span class="status ${audio ? "" : "status-muted"}"
                      >${audio ? yesIcon : noIcon}${audio ? "Yes, with ffmpeg" : "No"}</span
                    >
                  </td>
                </tr>`,
            )}
        </tbody>
      </table>
    </div>
  </div>
</section>`;

const content = html`<main>
  <section class="wrap" style="padding-top: 80px; padding-bottom: 56px;">
    <div class="stack gap-24">
      <p class="eyebrow eyebrow-accent">Integrations</p>
      <h1 class="h1" style="max-width: 13ch;">Works where you watch.</h1>
      <p class="lede">
        Stream in Stremio, keep a library in Sonarr, Radarr or Jellyfin, or play files from a
        folder. Each one fits subtitles to the exact file, and the fixes you share make everyone's
        subtitles better.
      </p>
    </div>
  </section>
  <section class="wrap" aria-label="Integrations" style="padding-bottom: 32px;">
    <div class="int-grid">${integrations.map(card)}</div>
  </section>
  ${comparison}
</main>`;

export const integrationsPage = (analytics?: boolean) =>
  layout({
    analytics,
    title: "Integrations",
    description:
      "Subs On Time for Stremio, Sonarr and Radarr through Bazarr, Bazarr+, Jellyfin, any player and your own tools.",
    active: "integrations",
    content,
  });
