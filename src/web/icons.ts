import { html } from "hono/html";

export const arrowIcon = html`<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
  <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" fill="none"></path>
</svg>`;

export const statusIcon = html`<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
  <path d="M3 8.5l3 3 7-7" stroke="#F5D547" stroke-width="2" fill="none"></path>
</svg>`;

export const yesIcon = html`<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
  <path d="M3 8.5l3 3 7-7" stroke="#F5D547" stroke-width="2" fill="none"></path>
</svg>`;

export const noIcon = html`<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
  <path d="M4 4l8 8M12 4l-8 8" stroke="#9A988F" stroke-width="1.8" fill="none"></path>
</svg>`;

export const removeIcon = html`<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
  <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6"></path>
</svg>`;

export const earlierIcon = html`<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
  <path d="M7.5 2L3.5 6l4 4" stroke="currentColor" stroke-width="1.6" fill="none"></path>
</svg>`;

export const copyIcon = html`<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
  <rect
    x="4"
    y="4"
    width="9"
    height="9"
    rx="1.5"
    stroke="currentColor"
    stroke-width="1.4"
    fill="none"
  ></rect>
  <path
    d="M10 2H2.5A1.5 1.5 0 001 3.5V10"
    stroke="currentColor"
    stroke-width="1.4"
    fill="none"
  ></path>
</svg>`;

export const menuIcon = html`<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
  <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" stroke-width="1.6" fill="none"></path>
</svg>`;

export const moreArrow = html`<span class="more-arrow" aria-hidden="true"
  ><svg width="14" height="14" viewBox="0 0 16 16">
    <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" fill="none"></path></svg
></span>`;

export const guideIcons: Record<string, ReturnType<typeof html>> = {
  stremio: html`<svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9"></circle>
    <path d="M10 8.5v7l5.5-3.5z"></path>
  </svg>`,
  bazarr: html`<svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M12 4v11m0 0l-4-4m4 4l4-4"></path>
    <path d="M5 19h14"></path>
  </svg>`,
  "bazarr-plus": html`<svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M9 4h6v4h-6z"></path>
    <path d="M5 8h14v12H5z"></path>
    <path d="M12 11v6m-3-3h6"></path>
  </svg>`,
  jellyfin: html`<svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="4" y="4" width="16" height="7" rx="1.5"></rect>
    <rect x="4" y="13" width="16" height="7" rx="1.5"></rect>
    <path d="M8 7.5h.01M8 16.5h.01"></path>
  </svg>`,
  cli: html`<svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="5" width="18" height="14" rx="2"></rect>
    <path d="M7 10l3 2-3 2M12 15h5"></path>
  </svg>`,
  api: html`<svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path
      d="M9 4H8a2 2 0 0 0-2 2v3.5L4.5 12 6 14.5V18a2 2 0 0 0 2 2h1M15 4h1a2 2 0 0 1 2 2v3.5l1.5 2.5-1.5 2.5V18a2 2 0 0 1-2 2h-1"
    ></path>
  </svg>`,
};
