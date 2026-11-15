import { html } from "hono/html";
import { logo } from "./header.ts";

export const footer = html`<footer class="site-footer">
  <div class="wrap site-footer-in">
    <div class="stack gap-16" style="max-width: 360px;">
      ${logo}
      <p class="small">
        Open source under GPL-3.0. Subtitles only, never video. No accounts, and nothing that says
        who you are.
      </p>
    </div>
    <nav class="foot-links" aria-label="Footer">
      <a href="/stremio">Stremio</a>
      <a href="/timings">Open Timings</a>
      <a href="/check">Check a file</a>
      <a href="/timings#api">API</a>
      <a href="https://github.com/jspthesixth/subsontime">GitHub</a>
      <a href="https://ko-fi.com/jspthesixth" target="_blank" rel="noopener">Support</a>
    </nav>
  </div>
</footer>`;
