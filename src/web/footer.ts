import { html } from "hono/html";
import { logo } from "./header.ts";

export const footer = (analytics: boolean) =>
  html`<footer class="site-footer">
    <div class="wrap site-footer-in">
      <div class="stack gap-16" style="max-width: 360px;">
        ${logo}
        <div class="stack gap-16">
          <p class="small">Open source under GPL-3.0.</p>
          <p class="small">Subtitles only, never video. No accounts.</p>
          ${analytics ? html`<p class="small">Anonymous visit counts, no cookies.</p>` : ""}
        </div>
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
