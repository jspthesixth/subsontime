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
