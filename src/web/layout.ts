import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { footer } from "./footer.ts";
import { header, type NavPage } from "./header.ts";

type Content = HtmlEscapedString | Promise<HtmlEscapedString>;

type LayoutProps = {
  title: string;
  description: string;
  active: NavPage;
  content: Content;
  scripts?: string[];
};

const favicon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230D0D0C'/%3E%3Crect x='7' y='19' width='18' height='5' rx='1' fill='%23F5D547'/%3E%3C/svg%3E";

export const layout = ({ title, description, active, content, scripts = [] }: LayoutProps) =>
  html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <meta name="description" content="${description}" />
        <meta name="theme-color" content="#0D0D0C" />
        <link rel="icon" href="${favicon}" />
        <link rel="stylesheet" href="/styles.css" />
        ${["menu", ...scripts].map((name) => html`<script type="module" src="/client/${name}.js"></script>`)}
      </head>
      <body>
        <div class="page">${header(active)} ${content} ${footer}</div>
      </body>
    </html>`;
