import { html } from "hono/html";
import { guideIcons, moreArrow } from "../icons.ts";
import { layout } from "../layout.ts";
import type { Doc, DocGroup } from "./doc.ts";
import { guides } from "./guides.ts";
import { concepts, referenceDocs } from "./reference.ts";

const groups: DocGroup[] = ["Get started", "How it works", "Reference", "Help"];

export const docsOf = (base: string): Doc[] => [
  ...guides(base),
  ...concepts,
  ...referenceDocs(base),
];

const githubEdit = "https://github.com/jspthesixth/subsontime/tree/main/src/web/docs";

const sidebar = (docs: Doc[], current?: string) =>
  html`<nav class="docs-nav" aria-label="Docs">
    <a class="docs-nav-link" href="/docs" aria-current="${current === undefined ? "page" : "false"}"
      >Overview</a
    >
    ${groups.map(
      (group) =>
        html`<div class="docs-nav-group">
          <p class="docs-nav-title">${group}</p>
          ${docs
            .filter((doc) => doc.group === group)
            .map(
              ({ slug, nav }) =>
                html`<a
                  class="docs-nav-link"
                  href="/docs/${slug}"
                  aria-current="${slug === current ? "page" : "false"}"
                  >${nav}</a
                >`,
            )}
        </div>`,
    )}
  </nav>`;

const mobileNav = (docs: Doc[], current?: Doc) =>
  html`<details class="docs-mobile-nav">
    <summary>
      <span class="small">Docs</span><span class="ink">${current?.nav ?? "Overview"}</span>
    </summary>
    ${sidebar(docs, current?.slug)}
  </details>`;

const pager = (docs: Doc[], doc: Doc) => {
  const index = docs.indexOf(doc);
  const previous = docs[index - 1];
  const next = docs[index + 1];

  return html`<nav class="docs-pager" aria-label="Previous and next">
    ${
      previous === undefined
        ? html`<span></span>`
        : html`<a class="docs-pager-link" href="/docs/${previous.slug}"
            ><span class="small">Previous</span><span class="ink">${previous.nav}</span></a
          >`
    }
    ${
      next === undefined
        ? html`<span></span>`
        : html`<a class="docs-pager-link docs-pager-next" href="/docs/${next.slug}"
            ><span class="small">Next</span><span class="ink">${next.nav}</span></a
          >`
    }
  </nav>`;
};

const shell = (
  docs: Doc[],
  current: Doc | undefined,
  article: ReturnType<typeof html>,
  toc = html``,
) =>
  html`<main class="wrap docs">
    <aside class="docs-side">${sidebar(docs, current?.slug)}</aside>
    <div class="docs-main">${mobileNav(docs, current)} ${article}</div>
    <aside class="docs-toc">${toc}</aside>
  </main>`;

const docArticle = (docs: Doc[], doc: Doc) =>
  shell(
    docs,
    doc,
    html`<article class="docs-article">
      <header class="docs-head">
        <p class="eyebrow eyebrow-accent">${doc.group}</p>
        <h1 class="docs-title">${doc.title}</h1>
        <p class="lede">${doc.summary}</p>
      </header>
      ${doc.sections.map(
        ({ id, title, body }) =>
          html`<section class="docs-section" id="${id}" aria-labelledby="${id}-title">
            <h2 class="docs-h2" id="${id}-title"><a href="#${id}">${title}</a></h2>
            ${body}
          </section>`,
      )}
      <p class="small docs-edit">
        Something wrong or missing? <a href="${githubEdit}">Edit this page on GitHub</a>.
      </p>
      ${pager(docs, doc)}
    </article>`,
    html`<nav class="docs-toc-in" aria-label="On this page">
      <p class="docs-nav-title">On this page</p>
      ${doc.sections.map(({ id, title }) => html`<a href="#${id}">${title}</a>`)}
    </nav>`,
  );

const setups = ["stremio", "bazarr", "bazarr-plus", "jellyfin", "cli"];

const cards = (docs: Doc[]) =>
  docs.map(
    ({ slug, title, summary }) =>
      html`<a class="int-card" href="/docs/${slug}">
        <span class="int-head">
          <span class="int-glyph" aria-hidden="true">${guideIcons[slug]}</span>
          <span class="h4">${title}</span>
        </span>
        <span class="small">${summary}</span>
      </a>`,
  );

const rows = (docs: Doc[]) =>
  html`<div class="list">
    ${docs.map(
      ({ slug, title, summary }) =>
        html`<a class="list-row doc-row" href="/docs/${slug}">
          <span class="list-main"
            ><span class="h4">${title}</span><span class="small">${summary}</span></span
          >
          ${moreArrow}
        </a>`,
    )}
  </div>`;

const overview = (docs: Doc[]) =>
  shell(
    docs,
    undefined,
    html`<article class="docs-article">
      <header class="docs-head">
        <p class="eyebrow eyebrow-accent">Docs</p>
        <h1 class="docs-title">Subtitles that fit your file.</h1>
        <p class="lede">
          Pick where you watch. Each guide takes a few minutes and ends with subtitles retimed to
          the exact video.
        </p>
      </header>
      <section class="docs-section" aria-labelledby="setups">
        <h2 class="docs-h2" id="setups">Set up</h2>
        <div class="doc-cards">${cards(docs.filter(({ slug }) => setups.includes(slug)))}</div>
      </section>
      <section class="docs-section" aria-labelledby="learn">
        <h2 class="docs-h2" id="learn">Learn and build</h2>
        ${rows(docs.filter(({ slug }) => !setups.includes(slug)))}
      </section>
    </article>`,
  );

export const docsPage = (base: string, slug: string | undefined, analytics?: boolean) => {
  const docs = docsOf(base);
  const doc = docs.find((each) => each.slug === slug);

  if (slug !== undefined && doc === undefined) {
    return undefined;
  }

  return layout({
    analytics,
    title: doc === undefined ? "Docs" : `${doc.title} - Docs`,
    description: doc?.summary ?? "Set up Subs On Time for Stremio, Bazarr, Jellyfin or any player.",
    active: "docs",
    content: doc === undefined ? overview(docs) : docArticle(docs, doc),
    scripts: ["docs"],
  });
};
