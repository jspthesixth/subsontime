import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export type Markup = HtmlEscapedString | Promise<HtmlEscapedString>;

export type DocSection = { id: string; title: string; body: Markup };

export type DocGroup = "Get started" | "How it works" | "Reference" | "Help";

export type Doc = {
  slug: string;
  group: DocGroup;
  nav: string;
  title: string;
  summary: string;
  sections: DocSection[];
};

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);

type Language = "bash" | "json" | "plaintext";

const highlighted = (text: string, language: Language) =>
  language === "plaintext" ? text : raw(hljs.highlight(text, { language }).value);

export const code = (text: string, label: string, language: Language = "plaintext") =>
  html`<div class="doc-code">
    <div class="doc-code-bar"><span class="doc-code-label">${label}</span></div>
    <pre class="code" data-copy>${highlighted(text, language)}</pre>
  </div>`;

export const steps = (items: Markup[]) =>
  html`<ol class="ol doc-steps">
    ${items.map((item) => html`<li><div class="stack gap-12">${item}</div></li>`)}
  </ol>`;

export const note = (body: Markup | string) => html`<aside class="doc-note">${body}</aside>`;

export const table = (head: string[], rows: (string | Markup)[][]) =>
  html`<div class="doc-table-wrap">
    <table class="doc-table">
      <thead>
        <tr>
          ${head.map((cell) => html`<th scope="col">${cell}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (row) =>
            html`<tr>
              ${row.map((cell) => html`<td>${cell}</td>`)}
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;

export const endpoint = (method: "GET" | "POST", path: string) =>
  html`<p class="doc-endpoint">
    <span class="doc-method doc-method-${method.toLowerCase()}">${method}</span><code>${path}</code>
  </p>`;
