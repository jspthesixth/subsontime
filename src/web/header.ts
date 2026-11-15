import { html } from "hono/html";
import { menuIcon } from "./icons.ts";

export type NavPage = "home" | "stremio" | "timings" | "check";

const navLinks: { page: NavPage; href: string; label: string }[] = [
  { page: "stremio", href: "/stremio", label: "Stremio" },
  { page: "timings", href: "/timings", label: "Open Timings" },
  { page: "check", href: "/check", label: "Check a file" },
];

export const logo = html`<a class="logo" href="/" aria-label="Subs On Time home">
  <span class="logo-word">subs on time</span>
  <span class="logo-bar" aria-hidden="true"></span>
</a>`;

export const header = (active: NavPage) =>
  html`<header class="site-header">
    <div class="wrap site-header-in">
      ${logo}
      <nav class="nav" aria-label="Main">
        <div class="nav nav-links" id="nav-links">
          ${navLinks.map(
            ({ page, href, label }) =>
              html`<a
                class="nav-link"
                href="${href}"
                aria-current="${page === active ? "page" : "false"}"
                ><span class="nav-label"
                  >${label}<span class="nav-bar" aria-hidden="true"></span></span
              ></a>`,
          )}
          <a class="nav-link" href="https://github.com/jspthesixth/subsontime"
            ><span class="nav-label">GitHub<span class="nav-bar" aria-hidden="true"></span></span
          ></a>
        </div>
        <a class="btn btn-primary btn-sm" href="/stremio">Add to Stremio</a>
        <button
          type="button"
          class="menu-btn"
          aria-label="Open menu"
          aria-expanded="false"
          aria-controls="nav-links"
        >
          ${menuIcon}
        </button>
      </nav>
    </div>
  </header>`;
