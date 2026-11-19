import { html } from "hono/html";
import { code, endpoint, note, steps, table, type Doc } from "./doc.ts";

const video = "335e59b519b80aa0:1051521287";
const fixId = "ad24d9d92b4344cf2df400a0c407f421";

const lookUpExample = `{
  "fixes": [
    {
      "id": "${fixId}",
      "subtitleSketch": ["004c6704ffaa4c0d", "0063dc34e009956a", "..."],
      "status": "hint",
      "method": "release-name",
      "agreeing": 1,
      "fromAudio": false,
      "cueCount": 580
    }
  ],
  "hidden": []
}`;

const cuesExample = `{
  "cues": [
    { "h": "5738822167a4e7e7", "s": 9676, "e": 12079 },
    { "h": "88861f9dda13055f", "s": 12079, "e": 15482 }
  ]
}`;

const fixBody = `{
  "video": { "hash": "335e59b519b80aa0", "size": 1051521287 },
  "subtitle": [
    { "h": "5738822167a4e7e7", "s": 9676, "e": 12079 },
    { "h": "88861f9dda13055f", "s": 12079, "e": 15482 }
  ],
  "method": "audio",
  "installId": "a random id your app keeps"
}`;

export const concepts: Doc[] = [
  {
    slug: "retiming",
    group: "How it works",
    nav: "How retiming works",
    title: "How retiming works",
    summary:
      "A subtitle is only useful when its lines appear when they are spoken. Subs On Time fits each subtitle to the exact file, in this order.",
    sections: [
      {
        id: "order",
        title: "The order",
        body: steps([
          html`<p class="body ink">A subtitle made for your file is used as it is.</p>
            <p class="small">
              OpenSubtitles marks subtitles uploaded for a file with the same fingerprint as yours.
            </p>`,
          html`<p class="body ink">The subtitle track inside your file.</p>
            <p class="small">
              With your stream addons added, Subs On Time finds the file you play and reads only its
              subtitle index: the times each line starts and ends, never audio or video. Every
              subtitle is lined up with that track, which was timed to this exact file. A file read
              once serves everyone who plays it.
            </p>`,
          html`<p class="body ink">A shared fix from Open Timings, when one exists.</p>
            <p class="small">
              Someone with the same file already fitted the same subtitle. The fix is applied line
              by line.
            </p>`,
          html`<p class="body ink">A reference: another subtitle made for your release.</p>
            <p class="small">
              Subtitles uploaded for the same release share its timing. Yours is aligned to them, at
              the frame rate most of them share, and served only when they agree.
            </p>`,
          html`<p class="body ink">The soundtrack, when the file is on your machine.</p>
            <p class="small">
              The command line, Bazarr and <code class="doc-inline">--audio</code> detect speech in
              the audio and line the subtitle up with it.
            </p>`,
        ]),
      },
      {
        id: "what-gets-fixed",
        title: "What gets fixed",
        body: table(
          ["Problem", "Looks like", "Fixed by"],
          [
            ["Offset", "Every line a second or more early or late", "Shifting every line"],
            [
              "Frame rate",
              "In sync at the start, drifting further off over time",
              "Scaling between 23.976, 24 and 25 fps",
            ],
            [
              "Cut",
              "In sync, then off by a jump after a scene that differs",
              "Shifting each part on its own",
            ],
            [
              "Another video",
              "Lines that never match the dialogue",
              "Leaving the subtitle out, and flagging it",
            ],
          ],
        ),
      },
      {
        id: "stremio",
        title: "Why Stremio needs your stream addons",
        body: html`<p class="body">
            Stremio sends an addon the title, and for most streams the file name. Never the video or
            its address. With your stream addons added, Subs On Time finds the same stream itself
            and reads the subtitle track inside the file. Without them, it can only fit a subtitle
            to other subtitles and to fixes shared by people who have the file.
          </p>
          <p class="body">
            Every fix made from the soundtrack, on the command line or in Bazarr, can reach Stremio
            through Open Timings. That is how one person's library makes everyone's subtitles
            better.
          </p>`,
      },
      {
        id: "check",
        title: "Check a subtitle yourself",
        body: html`<p class="body">
          <a href="/check">Check a file</a> shows every subtitle for a video, how each one was timed
          and how far it moved. Use it when a subtitle feels off, and report the ones that are.
        </p>`,
      },
    ],
  },
  {
    slug: "open-timings",
    group: "How it works",
    nav: "Open Timings",
    title: "Open Timings",
    summary:
      "The shared record of subtitle fixes: how to fit a subtitle to a file, found once and used by everyone. Times and fingerprints only.",
    sections: [
      {
        id: "fixes",
        title: "Fixes and hints",
        body: html`<p class="body">
            A fix is the new start and end time of each line of a subtitle, for one video file. A
            single submission is a <span class="ink">hint</span>. It becomes
            <span class="ink">confirmed</span> when two fixes from different connections agree, and
            one of them came from the soundtrack or they were made against different references.
          </p>
          <p class="body">
            Two fixes agree when they share at least 20 lines and at least 80% of those start and
            end within 100 ms of each other. A confirmed fix takes the median time of each line
            across the fixes that agree. Fixes that disagree are left out.
          </p>`,
      },
      {
        id: "fingerprints",
        title: "Fingerprints, not files",
        body: html`<p class="body">
            A video's fingerprint is the OpenSubtitles hash, made from its size and its first and
            last 64 KB, together with the size in bytes. It cannot be turned back into the video.
          </p>
          <p class="body">
            Each line's fingerprint is the first 16 hex characters of a SHA-256 of its words,
            lowercased and without punctuation or sound tags. The same subtitle from two sites, or
            in two encodings, is recognized as one. Very short common lines, like Yes, can be
            guessed from their fingerprint; longer lines cannot.
          </p>`,
      },
      {
        id: "privacy",
        title: "No one to identify",
        body: html`<p class="body">
          Submissions carry no account and no address. A daily-changing code makes it harder for one
          connection to confirm its own fix or hide a subtitle. It cannot be traced back after that
          day. Credentials stay in your own install link and never reach Open Timings.
        </p>`,
      },
      {
        id: "hidden",
        title: "Hidden subtitles",
        body: html`<p class="body">
          A subtitle flagged as made for another video, or reported as machine-translated, in the
          wrong language, missing lines, badly timed or with broken characters, is listed under
          hidden for that file once enough connections agree.
        </p>`,
      },
      {
        id: "use",
        title: "Use the data",
        body: html`<p class="body">
          Look up a file on the <a href="/timings">Open Timings page</a>, query the
          <a href="/docs/api">API</a>, or <a href="/docs/data">download the whole record</a>.
        </p>`,
      },
    ],
  },
];

export const referenceDocs = (base: string): Doc[] => [
  {
    slug: "api",
    group: "Reference",
    nav: "API",
    title: "Open Timings API",
    summary:
      "A public JSON API. No key, open to any origin. Read fixes for a file, and share fixes from your own app or player.",
    sections: [
      {
        id: "basics",
        title: "Basics",
        body: html`<p class="body">
            Every path starts with <code class="doc-inline">/api/v1</code>. Requests and responses
            are JSON, and a POST needs
            <code class="doc-inline">content-type: application/json</code>. A video is written as
            its 16-character hex OpenSubtitles hash and its size in bytes, joined by a colon:
          </p>
          ${code(video, "Video")}
          <p class="body">An error answers with a status code and one message:</p>
          ${code(`{ "error": "Send video as a 16-character hex hash and a size in bytes" }`, "400", "json")}`,
      },
      {
        id: "look-up",
        title: "Look up a file",
        body: html`${endpoint("GET", "/api/v1/fixes?video={hash}:{size}")}
          <p class="body">
            Every fix for one file, best first, and the subtitles hidden for it. Cached for five
            minutes.
          </p>
          ${code(`curl "${base}/api/v1/fixes?video=${video}"`, "Request", "bash")}
          ${code(lookUpExample, "Response", "json")}
          ${table(
            ["Field", "Meaning"],
            [
              [html`<code class="doc-inline">id</code>`, "The fix, for the cues endpoint."],
              [
                html`<code class="doc-inline">subtitleSketch</code>`,
                "Up to 128 line fingerprints that identify the subtitle the fix is for.",
              ],
              [
                html`<code class="doc-inline">status</code>`,
                html`<code class="doc-inline">confirmed</code> or
                  <code class="doc-inline">hint</code>.`,
              ],
              [
                html`<code class="doc-inline">method</code>`,
                html`<code class="doc-inline">audio</code>,
                  <code class="doc-inline">reference</code> or
                  <code class="doc-inline">release-name</code>.`,
              ],
              [html`<code class="doc-inline">agreeing</code>`, "How many fixes agree with it."],
              [
                html`<code class="doc-inline">fromAudio</code>`,
                "Whether one of them came from the soundtrack.",
              ],
              [html`<code class="doc-inline">cueCount</code>`, "Lines in the fix."],
              [
                html`<code class="doc-inline">hidden</code>`,
                html`Subtitles left out for this file, each with its
                  <code class="doc-inline">subtitleSketch</code>, a
                  <code class="doc-inline">reason</code> and a
                  <code class="doc-inline">count</code>.`,
              ],
            ],
          )}`,
      },
      {
        id: "cues",
        title: "Get the timed lines",
        body: html`${endpoint("GET", "/api/v1/fixes/{hash}:{size}/{id}/cues")}
          <p class="body">
            The lines of one fix: each line's fingerprint <code class="doc-inline">h</code>, and its
            start <code class="doc-inline">s</code> and end <code class="doc-inline">e</code> in
            milliseconds. To apply it, fingerprint each line of your subtitle the same way and take
            the new times of the lines that match. A fix that is no longer listed answers 404.
          </p>
          ${code(`curl "${base}/api/v1/fixes/${video}/${fixId}/cues"`, "Request", "bash")}
          ${code(cuesExample, "Response", "json")}`,
      },
      {
        id: "share-fix",
        title: "Share a fix",
        body: html`${endpoint("POST", "/api/v1/fixes")} ${code(fixBody, "Body", "json")}
          ${table(
            ["Field", "Rules"],
            [
              [
                html`<code class="doc-inline">video</code>`,
                "The hash as 16 hex characters and the size in bytes.",
              ],
              [
                html`<code class="doc-inline">subtitle</code>`,
                "1 to 5000 lines, in order of start time, each with a fingerprint and times in milliseconds.",
              ],
              [
                html`<code class="doc-inline">method</code>`,
                html`<code class="doc-inline">audio</code>,
                  <code class="doc-inline">reference</code> or
                  <code class="doc-inline">release-name</code>.`,
              ],
              [
                html`<code class="doc-inline">referenceKey</code>`,
                "Optional. Up to 8 comma-separated subtitle fingerprints of the references used.",
              ],
              [
                html`<code class="doc-inline">installId</code>`,
                "Optional. A random id your app keeps, so its own fixes do not confirm each other.",
              ],
            ],
          )}
          <p class="body">
            Answers <code class="doc-inline">202</code> with
            <code class="doc-inline">{ "ok": true }</code>.
          </p>`,
      },
      {
        id: "flag",
        title: "Flag or report a subtitle",
        body: html`${endpoint("POST", "/api/v1/mismatches")}
          <p class="body">A subtitle made for another video.</p>
          ${code(
            `{ "video": { "hash": "335e59b519b80aa0", "size": 1051521287 }, "subtitleHashes": ["5738822167a4e7e7", "..."] }`,
            "Body",
            "json",
          )}
          ${endpoint("POST", "/api/v1/reports")}
          <p class="body">
            A problem with a subtitle: the same body with a
            <code class="doc-inline">reason</code>, one of
            <code class="doc-inline">machine-translated</code>,
            <code class="doc-inline">wrong-language</code>,
            <code class="doc-inline">lines-missing</code>,
            <code class="doc-inline">timing-off</code> or
            <code class="doc-inline">broken-characters</code>.
          </p>`,
      },
      {
        id: "stats",
        title: "Stats",
        body: html`${endpoint("GET", "/api/v1/stats")}
        ${code(`{ "fixes": 16, "confirmed": 0, "videos": 15, "hidden": 0 }`, "Response", "json")}`,
      },
      {
        id: "limits",
        title: "Limits",
        body: table(
          ["What", "Limit", "Over it"],
          [
            ["Shares, flags and reports", "60 an hour per connection", "429"],
            ["Stats", "60 a minute per connection", "429"],
            ["Body", "JSON only", "415"],
          ],
        ),
      },
    ],
  },
  {
    slug: "data",
    group: "Reference",
    nav: "Data download",
    title: "Data download",
    summary: "The whole record as one file, rebuilt every day. Free to use for anything, CC0-1.0.",
    sections: [
      {
        id: "download",
        title: "Download",
        body: html`<p class="body">
            <code class="doc-inline">/api/v1/dump</code> redirects to the latest file, gzipped JSON
            Lines.
          </p>
          ${code(`curl -L ${base}/api/v1/dump | gunzip > open-timings.jsonl`, "Shell", "bash")}
          <p><a class="btn btn-ghost" href="/api/v1/dump">Download the data</a></p>`,
      },
      {
        id: "format",
        title: "Format",
        body: html`<p class="body">
            One line per video file: its <code class="doc-inline">video</code> key, and the same
            <code class="doc-inline">fixes</code> and <code class="doc-inline">hidden</code> as the
            <a href="/docs/api#look-up">look-up</a> answers.
          </p>
          ${code(`{"video":"${video}","fixes":[{"id":"${fixId}","subtitleSketch":["004c6704ffaa4c0d","..."],"status":"hint","method":"release-name","agreeing":1,"fromAudio":false,"cueCount":580}],"hidden":[]}`, "One line", "json")}`,
      },
    ],
  },
  {
    slug: "self-hosting",
    group: "Reference",
    nav: "Self-hosting",
    title: "Self-hosting",
    summary:
      "Run your own Subs On Time server with Docker. Stremio, Jellyfin and Bazarr+ then use your install links.",
    sections: [
      {
        id: "docker",
        title: "Docker",
        body: html`<p class="body">
            The image runs on linux/amd64 and linux/arm64. It needs two secrets, each at least 32
            characters and different from each other.
          </p>
          ${code(
            `docker run -e SECRET=$(openssl rand -hex 32) -e INSTALL_SALT=$(openssl rand -hex 32) \\
  -p 7000:7000 ghcr.io/jspthesixth/subsontime`,
            "Shell",
            "bash",
          )}
          <p class="body">
            Open <code class="doc-inline">http://localhost:7000/stremio</code> to make an install
            link.
          </p>
          ${note(
            html`Keep the two secrets. Install links are sealed with
              <code class="doc-inline">SECRET</code>, so a new one breaks every link made before.`,
          )}`,
      },
      {
        id: "more",
        title: "Postgres, Redis and proxies",
        body: html`<p class="body">
          Without a database, fixes stay in memory and are lost on restart. The
          <a href="https://github.com/jspthesixth/subsontime#self-hosting">README</a> has a Docker
          Compose file with Postgres, the Redis setup for more than one instance, the proxy settings
          and every environment variable.
        </p>`,
      },
    ],
  },
  {
    slug: "troubleshooting",
    group: "Help",
    nav: "Troubleshooting",
    title: "Troubleshooting",
    summary: "The common problems, and what to do about each.",
    sections: [
      {
        id: "off",
        title: "A subtitle is early or late",
        body: html`<p class="body">
          Open <a href="/check">Check a file</a> with the same file, pick the subtitle and see how
          it was timed. If it is still off, report it there with timing off: once others agree it is
          hidden for that file. Try another subtitle from the list in the meantime.
        </p>`,
      },
      {
        id: "none",
        title: "No subtitles in Stremio",
        body: html`<p class="body">
          Check that your language is in your settings and that a source has subtitles for the
          title. A subtitle that fits no other subtitle of the video is left out when Hide subtitles
          made for another video is on, so an entry can come back empty.
        </p>`,
      },
      {
        id: "old-link",
        title: "This link is for a newer version",
        body: html`<p class="body">
          Your install link was made by a newer server than the one answering. Make a new link on
          the <a href="/stremio">setup page</a> and install it again.
        </p>`,
      },
      {
        id: "bazarr-left",
        title: "Bazarr leaves every subtitle as it is",
        body: html`<p class="body">
            Read the reason after <code class="doc-inline">left as it is</code> in Bazarr's log. The
            usual ones:
          </p>
          ${table(
            ["Reason", "What to do"],
            [
              ["ffmpeg is needed", "Install ffmpeg in the container, or set SUBSONTIME_FFMPEG."],
              [
                "not clear enough",
                "The audio did not decide it. The subtitle stays as Bazarr wrote it.",
              ],
              ["only .srt subtitles are retimed", "Set Bazarr to download .srt."],
            ],
          )}`,
      },
      {
        id: "permission",
        title: "Bazarr cannot write the subtitle",
        body: html`<p class="body">
          The folder next to the video must be writable by Bazarr's user. In Docker, check the owner
          of the media folders and the container's PUID and PGID.
        </p>`,
      },
      {
        id: "help",
        title: "Still stuck",
        body: html`<p class="body">
          Open an issue on
          <a href="https://github.com/jspthesixth/subsontime/issues">GitHub</a> with the file name,
          the language and what you saw. Never paste your install link: it carries your settings.
        </p>`,
      },
    ],
  },
  {
    slug: "privacy",
    group: "Help",
    nav: "Privacy",
    title: "Privacy",
    summary:
      "What Subs On Time reads, what it keeps and for how long. There are no accounts, and your settings stay in your own install link.",
    sections: [
      {
        id: "install-link",
        title: "Your install link",
        body: html`<p class="body">
          Your languages, sources, logins and stream addons are sealed, encrypted, inside your
          install link. Subs On Time keeps no copy of them. It opens the link only to answer a
          request from Stremio, and uses your logins only to search and download subtitles for you.
        </p>`,
      },
      {
        id: "playing",
        title: "When you play something",
        body: html`<p class="body">
            Stremio sends the title, and for most streams the file name, sometimes also its size and
            fingerprint. Subs On Time searches the subtitle sources you chose with that and lines
            the subtitles up.
          </p>
          <p class="body">
            When you add stream addons, it also asks them for the streams of what you play, opens
            the matching file through the service your stream addon uses, and reads only the file's
            header, track list and subtitle index: the times each line starts and ends, never audio
            or video. For a file without subtitles inside, it reads two 64 KB pieces from its start
            and end to compute the file's fingerprint, and keeps only that fingerprint.
          </p>`,
      },
      {
        id: "kept",
        title: "What is kept",
        body: table(
          ["What", "Tied to your install", "Kept for"],
          [
            ["Which file you played for a title", "Yes", "7 days"],
            ["Your BluRay, WEB or DVD timing choice for a series season", "Yes", "7 days"],
            ["The subtitles served to you", "Yes", "24 hours"],
            ["A file's fingerprint by its file name", "Yes", "4 hours"],
            ["Login sessions with your subtitle sources", "Yes", "Until they expire"],
            ["Each file's subtitle timings and fingerprint", "No", "30 days"],
            ["Which file a file name belongs to", "No", "30 days"],
            ["Subtitles downloaded from the sources", "No", "24 hours"],
            ["Counts of requests per day, by app and by how timing was found", "No", "35 days"],
          ],
        ),
      },
      {
        id: "open-timings",
        title: "Open Timings",
        body: html`<p class="body">
          Only with <span class="ink">Share the fixes made for me</span> on: the new time of each
          line with its fingerprint, the video's fingerprint, a code made from your install that
          cannot be turned back into it, and a code made from your connection that changes every day
          and cannot be traced after that day. Fixes stay in the shared record. The public
          <a href="/docs/data">daily download</a> leaves out both codes.
        </p>`,
      },
      {
        id: "others",
        title: "Who else is involved",
        body: html`<p class="body">
            Vercel hosts Subs On Time. Its request logs, kept for a short time, include the
            requested address, with your install link and the file name, and your IP address. The
            website counts visits anonymously, without cookies.
          </p>
          <p class="body">
            The subtitle sources you chose, and the stream addons you added with the services they
            use, receive the requests made for you, under your own logins.
          </p>`,
      },
      {
        id: "questions",
        title: "Questions",
        body: html`<p class="body">
          Open an issue on
          <a href="https://github.com/jspthesixth/subsontime/issues">GitHub</a>. Never paste your
          install link there.
        </p>`,
      },
    ],
  },
];
