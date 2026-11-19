import { html } from "hono/html";
import { bazarrCommand } from "../../cli/bazarr-command.ts";
import { code, note, steps, table, type Doc } from "./doc.ts";

const releaseZip =
  "https://github.com/jspthesixth/subsontime/releases/latest/download/subsontime-bazarr-plus.zip";

const installLinkStep = html`<p class="body ink">Paste your install link.</p>
  <p class="small">
    Make one on the <a href="/stremio">setup page</a>: pick languages and sources, then copy the
    link instead of installing. It carries your settings, sealed, so there is no account.
  </p>`;

const installCommand = (base: string) =>
  code(`curl -fsSL ${base}/install.sh | sh`, "Shell", "bash");

export const guides = (base: string): Doc[] => [
  {
    slug: "stremio",
    group: "Get started",
    nav: "Stremio",
    title: "Stremio",
    summary:
      "An addon that lists subtitles for the stream you are playing and retimes each one to it. Works with every stream and debrid service.",
    sections: [
      {
        id: "install",
        title: "Install",
        body: steps([
          html`<p class="body ink">Open the <a href="/stremio">setup page</a>.</p>`,
          html`<p class="body ink">Pick your languages.</p>`,
          html`<p class="body ink">Choose your sources.</p>
            <p class="small">
              OpenSubtitles works without an account. Titlovi, SubDL and SubSource take your own
              login or API key, checked before it is saved. Any other Stremio subtitle addon can be
              added by its address.
            </p>`,
          html`<p class="body ink">Choose <span class="ink">Install in Stremio</span>.</p>
            <p class="small">
              Stremio opens and asks to install. On a TV or a second device, scan the QR code or
              copy the link.
            </p>`,
        ]),
      },
      {
        id: "timing",
        title: "Timing",
        body: html`<p class="body">
            With timing on, each subtitle gets a shared fix from Open Timings when one exists for
            your exact file. Otherwise it is retimed against a subtitle made for the same release.
            Turn timing off to get subtitles as the sources have them.
          </p>
          <p class="body">
            <a href="/docs/retiming">How retiming works</a> explains the order in which this
            happens.
          </p>`,
      },
      {
        id: "extras",
        title: "Extras",
        body: table(
          ["Setting", "What it does"],
          [
            [
              "Hide subtitles made for another video",
              "Leaves out a subtitle whose dialogue does not line up with your file at all.",
            ],
            [
              "Dialogue only",
              "Also offers a copy without hearing-impaired tags like [music] and speaker names.",
            ],
            [
              "Foreign parts only",
              "A subtitle with only the lines spoken in another language, when a source has one.",
            ],
            [
              "Dual subtitles",
              "Your first language on top, a second one below, timed to the same reference.",
            ],
            [
              "Show the source in the language name",
              "For TV apps that show only the language. Stremio then stops picking your language by itself.",
            ],
          ],
        ),
      },
      {
        id: "change-settings",
        title: "Change your settings",
        body: html`<p class="body">
          In Stremio, open Addons, find Subs On Time and choose Configure. The setup page opens with
          your current settings. Save, install the new link, then remove the old Subs On Time from
          Stremio.
        </p>`,
      },
    ],
  },
  {
    slug: "bazarr",
    group: "Get started",
    nav: "Sonarr and Radarr",
    title: "Sonarr and Radarr, through Bazarr",
    summary:
      "Bazarr downloads subtitles for your Sonarr and Radarr library. Subs On Time runs after each download and fits the subtitle to the file.",
    sections: [
      {
        id: "what-it-does",
        title: "What it does",
        body: html`<p class="body">After Bazarr saves a subtitle, the command:</p>
          <ul class="doc-list">
            <li>applies a fix from Open Timings when one exists for that file and subtitle,</li>
            <li>otherwise syncs the subtitle to the audio with ffmpeg,</li>
            <li>and leaves the subtitle as it is when it was made for another video.</li>
          </ul>
          <p class="body">It never removes a subtitle and only rewrites .srt files.</p>`,
      },
      {
        id: "install",
        title: "Install",
        body: steps([
          html`<p class="body ink">Install the command where Bazarr runs.</p>
            <p class="small">
              For Bazarr in Docker, run it inside the container. The command checks the download
              against the release checksums and installs to
              <code class="doc-inline">/usr/local/bin</code>, or
              <code class="doc-inline">~/.local/bin</code> when that is not writable.
            </p>
            ${installCommand(base)}`,
          html`<p class="body ink">Make sure ffmpeg is there.</p>
            <p class="small">
              It needs ffmpeg on the <code class="doc-inline">PATH</code>, or
              <code class="doc-inline">SUBSONTIME_FFMPEG</code> set to its path. Without it, only
              shared fixes are applied.
            </p>`,
          html`<p class="body ink">
              In Bazarr, open Settings, Subtitles, Post-Processing. Turn on custom post-processing
              and paste:
            </p>
            ${code(bazarrCommand, "Post-processing command", "bash")}`,
        ]),
      },
      {
        id: "docker",
        title: "Docker",
        body: html`<p class="body">
            The linuxserver.io image runs Bazarr as a user that cannot write its home folder. Give
            the command a folder for its install id:
          </p>
          ${code("SUBSONTIME_CONFIG_DIR=/config/subsontime", "Container environment")}
          ${note(
            html`The command lives inside the container, so a new image removes it. Run the install
            again after you update Bazarr, or install it from a custom init script.`,
          )}`,
      },
      {
        id: "log",
        title: "Reading the log",
        body: html`<p class="body">
            Each run prints one line starting with
            <code class="doc-inline">subsontime:</code> to Bazarr's log, for example:
          </p>
          ${code(
            "subsontime: synced to the audio +1.20 s · contrast 9.4 · not shared, audio check not reliable enough yet",
            "Bazarr log",
          )}
          <p class="body">
            A line saying the subtitle was left as it is gives the reason, such as ffmpeg missing or
            the audio not being clear enough to be sure.
          </p>`,
      },
    ],
  },
  {
    slug: "bazarr-plus",
    group: "Get started",
    nav: "Bazarr+",
    title: "Bazarr+",
    summary:
      "A provider for the Bazarr+ Provider Hub. Bazarr+ searches Subs On Time like any other provider, and gets subtitles already fitted to the file.",
    sections: [
      {
        id: "install",
        title: "Install",
        body: steps([
          html`<p class="body ink">
            Download <a href="${releaseZip}">subsontime-bazarr-plus.zip</a> from the latest release.
          </p>`,
          html`<p class="body ink">In Provider Hub, upload the zip and restart Bazarr+.</p>`,
          html`<p class="body ink">Turn on Subs On Time.</p>`,
          installLinkStep,
        ]),
      },
      {
        id: "test",
        title: "Check it works",
        body: html`<p class="body">
          The provider's Test button in Provider Hub calls Subs On Time with your link and reports
          ready when it answers. A manual search on a movie or episode then lists Subs On Time
          entries for your languages.
        </p>`,
      },
    ],
  },
  {
    slug: "jellyfin",
    group: "Get started",
    nav: "Jellyfin",
    title: "Jellyfin",
    summary:
      "A plugin that finds subtitles for your library through Jellyfin's subtitle search and applies shared fixes file by file.",
    sections: [
      {
        id: "install",
        title: "Install",
        body: steps([
          html`<p class="body ink">In the Dashboard, open Plugins, Repositories, and add:</p>
            ${code(`${base}/jellyfin/manifest.json`, "Repository URL")}`,
          html`<p class="body ink">Install Subs On Time from the Catalog and restart Jellyfin.</p>`,
          html`<p class="body ink">Open the plugin's settings.</p>`,
          installLinkStep,
        ]),
      },
      {
        id: "use",
        title: "Use it",
        body: html`<p class="body">
            On a movie or episode, open the subtitle search and pick a language. Subs On Time
            entries come back fitted to that file. Jellyfin saves the chosen one next to the video.
          </p>
          <p class="body">
            For a whole library, turn on Subs On Time under the library's subtitle downloaders, and
            Jellyfin's scheduled task fetches missing subtitles with it.
          </p>`,
      },
    ],
  },
  {
    slug: "cli",
    group: "Get started",
    nav: "Command line",
    title: "Command line",
    summary:
      "For mpv, VLC, Kodi or a folder of files. One command finds subtitles, fits them to each video and writes them next to it.",
    sections: [
      {
        id: "install",
        title: "Install",
        body: html`<p class="body">Linux and macOS, x64 and arm64:</p>
          ${installCommand(base)}`,
      },
      {
        id: "fix",
        title: "Fix a file or a folder",
        body: html`${code(
            `subsontime fix "Example.Movie.2024.1080p.WEB-DL-GROUP.mkv" --lang hr,en
subsontime fix ~/Movies --lang hr --recursive`,
            "Shell",
            "bash",
          )}
          <p class="body">
            It writes <code class="doc-inline">&lt;video name&gt;.&lt;language&gt;.srt</code> next
            to each video. It never overwrites a subtitle: when that name is taken it writes
            <code class="doc-inline">&lt;video name&gt;.&lt;language&gt;.subsontime.srt</code>.
            Samples and files under 50 MB are left out.
          </p>`,
      },
      {
        id: "audio",
        title: "Sync to the audio",
        body: html`<p class="body">
            <code class="doc-inline">--audio</code> lines each subtitle up with the soundtrack. It
            needs ffmpeg on the <code class="doc-inline">PATH</code>, or
            <code class="doc-inline">SUBSONTIME_FFMPEG</code> pointing at one.
          </p>
          ${code(`subsontime fix "Example.Movie.2024.mkv" --lang en --audio`, "Shell", "bash")}
          <p class="body">To fit a subtitle you already have, with no network at all:</p>
          ${code(
            `subsontime fix "Example.Movie.2024.mkv" --subtitle movie.srt --lang en --audio --offline`,
            "Shell",
            "bash",
          )}`,
      },
      {
        id: "options",
        title: "Options",
        body: table(
          ["Option", "What it does"],
          [
            [
              html`<code class="doc-inline">--lang &lt;codes&gt;</code>`,
              "Languages, ISO 639-1 or 639-2, comma separated. Defaults to yours and English.",
            ],
            [
              html`<code class="doc-inline">--audio</code>`,
              "Align to the soundtrack. Needs ffmpeg.",
            ],
            [
              html`<code class="doc-inline">--private</code>`,
              "Make no contact with Open Timings: no lookup, no sharing.",
            ],
            [
              html`<code class="doc-inline">--offline</code>`,
              "Make no network call. Needs --subtitle and --audio.",
            ],
            [
              html`<code class="doc-inline">--subtitle &lt;path&gt;</code>`,
              "Time this subtitle instead of searching. One --lang.",
            ],
            [
              html`<code class="doc-inline">--imdb &lt;tt...&gt;</code>`,
              "The IMDb id, when the file name does not find the title.",
            ],
            [
              html`<code class="doc-inline">--sources &lt;names&gt;</code>`,
              "Only these sources: opensubtitles, titlovi, subdl, subsource.",
            ],
            [html`<code class="doc-inline">--recursive</code>`, "Walk sub-folders too."],
            [
              html`<code class="doc-inline">--out &lt;folder&gt;</code>`,
              "Write the subtitles into this folder.",
            ],
            [
              html`<code class="doc-inline">--api &lt;url&gt;</code>`,
              "Open Timings address. Defaults to this site.",
            ],
          ],
        ),
      },
      {
        id: "sources",
        title: "Sources",
        body: html`<p class="body">
            OpenSubtitles works without an account. These environment variables add sources or use
            your own accounts:
          </p>
          ${table(
            ["Variable", "Source"],
            [
              [html`<code class="doc-inline">OPENSUBTITLES_APP_KEY</code>`, "OpenSubtitles API"],
              [
                html`<code class="doc-inline">OPENSUBTITLES_USERNAME</code>,
                  <code class="doc-inline">OPENSUBTITLES_PASSWORD</code>`,
                "Download OpenSubtitles with your own account",
              ],
              [
                html`<code class="doc-inline">TITLOVI_USERNAME</code>,
                  <code class="doc-inline">TITLOVI_PASSWORD</code>`,
                "Titlovi",
              ],
              [html`<code class="doc-inline">SUBDL_API_KEY</code>`, "SubDL"],
              [html`<code class="doc-inline">SUBSOURCE_API_KEY</code>`, "SubSource"],
            ],
          )}`,
      },
      {
        id: "exit-codes",
        title: "Exit codes",
        body: table(
          ["Code", "Meaning"],
          [
            ["0", "Wrote at least one subtitle."],
            ["1", "Wrote none."],
            ["2", "Usage error."],
            ["3", "--audio was given without ffmpeg."],
          ],
        ),
      },
    ],
  },
];
