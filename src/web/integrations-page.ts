import { html } from "hono/html";
import { bazarrCommand } from "../cli/bazarr-command.ts";
import { statusIcon } from "./icons.ts";
import { layout } from "./layout.ts";

const onThisPage = [
  { id: "bazarr", label: "Bazarr" },
  { id: "bazarr-plus", label: "Bazarr+" },
  { id: "jellyfin", label: "Jellyfin" },
  { id: "cli", label: "Any player" },
  { id: "own", label: "Build your own" },
];

const bazarrDoes = [
  "Applies confirmed fixes",
  "Syncs against the audio with ffmpeg",
  "Leaves subtitles for another video as they are",
];

const installLinkNote = html`<span class="small"
  >Get the install link from the <a href="/stremio">setup page</a>.</span
>`;

const content = (base: string) => {
  const install = html`<pre class="code">curl -fsSL ${base}/install.sh | sh</pre>`;

  return html`<main class="wrap" style="padding-top: 80px; padding-bottom: 112px;">
    <div class="stack gap-24" style="padding-bottom: 64px;">
      <p class="eyebrow eyebrow-accent">Your library</p>
      <h1 class="h1" style="max-width: 14ch;">Your files make everyone's subtitles better.</h1>
      <p class="lede">
        You have the video, so your subtitles can be fitted to the exact file. Share the fixes and
        everyone streaming the same file gets them. Use the fixes others found and your library
        needs less syncing.
      </p>
      <nav class="row-wrap gap-8" aria-label="On this page">
        ${onThisPage.map(
          ({ id, label }) =>
            html`<a
              class="tag"
              href="#${id}"
              style="padding: 8px 14px; font-size: 13px; text-decoration: none;"
              >${label}</a
            >`,
        )}
      </nav>
    </div>

    <div class="stack gap-64">
      <section id="bazarr" class="integration" aria-labelledby="i1">
        <div class="stack gap-12">
          <h2 class="h3" id="i1">Sonarr and Radarr, through Bazarr</h2>
          <p class="body">A post-processing command. Works with the Bazarr you already run.</p>
          <div class="stack gap-8" style="padding-top: 8px;">
            ${bazarrDoes.map((line) => html`<span class="status">${statusIcon}${line}</span>`)}
          </div>
        </div>
        <ol class="ol">
          <li>
            <span class="body ink"
              >Install the command on the machine or container that runs Bazarr.</span
            >${install}
          </li>
          <li>
            <span class="body ink"
              >In Bazarr, open Settings, Subtitles, Post-Processing. Turn on custom post-processing
              and paste:</span
            >
            <pre class="code">${bazarrCommand}</pre>
          </li>
        </ol>
      </section>

      <section id="bazarr-plus" class="integration" aria-labelledby="i2">
        <div class="stack gap-12">
          <h2 class="h3" id="i2">Bazarr+</h2>
          <p class="body">A provider for its Provider Hub. No command to install.</p>
        </div>
        <ol class="ol">
          <li>
            <span class="body ink"
              >Download
              <a
                href="https://github.com/jspthesixth/subsontime/releases/latest/download/subsontime-bazarr-plus.zip"
                >subsontime-bazarr-plus.zip</a
              >
              from the latest release.</span
            >
          </li>
          <li>
            <span class="body ink">In Provider Hub, upload the zip and restart Bazarr+.</span>
          </li>
          <li>
            <span class="body ink"
              >Turn on Subs On Time and paste your install link in its settings.</span
            >${installLinkNote}
          </li>
        </ol>
      </section>

      <section id="jellyfin" class="integration" aria-labelledby="i3">
        <div class="stack gap-12">
          <h2 class="h3" id="i3">Jellyfin</h2>
          <p class="body">
            A plugin that finds subtitles for your library and applies shared fixes file by file.
          </p>
        </div>
        <ol class="ol">
          <li>
            <span class="body ink">In the Dashboard, open Plugins, Repositories, and add:</span>
            <pre class="code">${base}/jellyfin/manifest.json</pre>
          </li>
          <li>
            <span class="body ink"
              >Install Subs On Time from the Catalog and restart Jellyfin.</span
            >
          </li>
          <li>
            <span class="body ink">Paste your install link in the plugin settings.</span
            >${installLinkNote}
          </li>
        </ol>
      </section>

      <section id="cli" class="integration" aria-labelledby="i4">
        <div class="stack gap-12">
          <h2 class="h3" id="i4">Any player</h2>
          <p class="body">
            For mpv, VLC, Kodi or a folder of files. One command writes a fitted subtitle next to
            the video.
          </p>
        </div>
        <ol class="ol">
          <li><span class="body ink">Install the command.</span>${install}</li>
          <li>
            <span class="body ink">Fix one file, or a whole folder.</span>
            <pre class="code">
subsontime fix "Example.Movie.2024.mkv" --lang hr,en
subsontime fix ~/Movies --lang hr</pre>
          </li>
          <li>
            <span class="body ink"
              >Add <span class="mono">--audio</span> to sync against the soundtrack.</span
            ><span class="small"
              >Needs ffmpeg. Add --private to make no contact with Open Timings.</span
            >
          </li>
        </ol>
      </section>

      <section id="own" class="integration" aria-labelledby="i5">
        <div class="stack gap-12">
          <h2 class="h3" id="i5">Build your own</h2>
          <p class="body">Open Timings has a public API. Plug it into any player or tool.</p>
        </div>
        <div class="stack gap-16">
          <pre class="code">
<span class="c"># every known fix for one video file</span>
GET ${base}/api/v1/fixes?video=<span class="a">8e245d9679d31e12</span>:4703284372</pre>
          <div><a class="btn btn-ghost" href="/timings#api">API and data</a></div>
        </div>
      </section>
    </div>
  </main>`;
};

export const integrationsPage = (base: string, analytics?: boolean) =>
  layout({
    analytics,
    title: "Integrations",
    description:
      "Subs On Time for Sonarr and Radarr through Bazarr, Bazarr+, Jellyfin and any player.",
    active: "integrations",
    content: content(base),
  });
