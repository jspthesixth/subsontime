import { html } from "hono/html";
import { arrowIcon, copyIcon, moreArrow } from "./icons.ts";

export const removeOldInstall = "Remove the old Subs On Time in Stremio after installing this one.";

export const installedView = html`<main
  class="wrap"
  style="padding-top: 80px; padding-bottom: 112px;"
>
  <div class="grid-2" style="gap: 64px; align-items: start;">
    <div class="stack gap-32">
      <div class="stack gap-16">
        <p class="eyebrow" id="installed-summary"></p>
        <p class="lede">
          Open Stremio and confirm. Then play anything: subtitles arrive in the player, already
          timed.
        </p>
        <p class="small" id="installed-edit-note" hidden>${removeOldInstall}</p>
      </div>
      <div class="row-wrap gap-12">
        <a class="btn btn-primary btn-wide-mobile" id="open-stremio"
          >Open in Stremio ${arrowIcon}</a
        >
        <a class="btn btn-ghost btn-wide-mobile" id="stremio-web" target="_blank" rel="noreferrer"
          >Use Stremio Web</a
        >
      </div>
      <div class="field divided">
        <label class="label" for="install-link">Your install link</label>
        <div class="input-row">
          <input id="install-link" class="input input-mono" type="text" readonly />
          <button type="button" class="btn btn-light" id="copy-link">
            ${copyIcon}<span id="copy-label" aria-live="polite">Copy</span>
          </button>
        </div>
        <p class="hint">
          It holds your settings and keys, encrypted. Keep it private, like a password. Paste it on
          the setup page to change anything later.
        </p>
      </div>
      <div class="stack gap-12 divided">
        <h2 class="h4">What happens next</h2>
        <ol class="ol">
          <li><span class="body ink">Stremio asks you to confirm the addon.</span></li>
          <li>
            <span class="body ink"
              >Play anything. Open the subtitle menu once and pick your language.</span
            ><span class="small">After that it turns on by itself.</span>
          </li>
          <li>
            <span class="body ink">Something looks wrong?</span
            ><span class="small">See every subtitle and how it was timed.</span
            ><a class="more" href="/check">Check that file${moreArrow}</a>
          </li>
        </ol>
      </div>
    </div>

    <aside
      class="panel panel-pad stack gap-16"
      style="align-items: center; text-align: center;"
      aria-labelledby="tv-title"
    >
      <h2 class="h4" id="tv-title">On a TV or another phone</h2>
      <div class="qr" id="install-qr" role="img" aria-label="QR code for the install link"></div>
      <p class="small" style="max-width: 280px;">
        Scan it on the device signed in to the same Stremio account. The addon then follows your
        account everywhere.
      </p>
    </aside>
  </div>
</main>`;
