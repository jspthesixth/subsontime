import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const app = createApp({
  secret: "a-test-secret-that-is-long-enough-1234",
});

describe.each(["/", "/stremio", "/check", "/timings", "/integrations"])("GET %s", (path) => {
  it("returns an English HTML page with one h1 and the stylesheet", async () => {
    const response = await app.request(path);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(page).toContain('<html lang="en">');
    expect(page.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(page).toMatch(/<link rel="stylesheet" href="\/styles\.css"/);
  });

  it("links Integrations from the header and the footer", async () => {
    const page = await (await app.request(path)).text();

    expect(page).toMatch(/<header[\s\S]*href="\/integrations"[\s\S]*<\/header>/);
    expect(page).toMatch(/<footer[\s\S]*href="\/integrations"[\s\S]*<\/footer>/);
  });

  it("links Open Timings from the header and the footer", async () => {
    const page = await (await app.request(path)).text();

    expect(page.match(/href="\/timings"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(page).toMatch(/<header[\s\S]*href="\/timings"[\s\S]*<\/header>/);
    expect(page).toMatch(/<footer[\s\S]*href="\/timings"[\s\S]*<\/footer>/);
  });

  it("loads Vercel Web Analytics and says so only on Vercel", async () => {
    const insights = '<script type="module" src="/client/insights.js"></script>';
    const notice = "Anonymous visit counts, no cookies.";
    const onVercel = createApp({
      secret: "a-test-secret-that-is-long-enough-1234",
      analytics: true,
    });
    const vercelPage = await (await onVercel.request(path)).text();
    const page = await (await app.request(path)).text();

    expect(vercelPage).toContain(insights);
    expect(vercelPage).toContain(notice);
    expect(page).not.toContain("/client/insights.js");
    expect(page).not.toContain(notice);
  });

  it("splits the footer text into three short lines on Vercel and two elsewhere", async () => {
    const onVercel = createApp({
      secret: "a-test-secret-that-is-long-enough-1234",
      analytics: true,
    });

    expect(footerLines(await (await onVercel.request(path)).text())).toEqual([
      "Open source under GPL-3.0.",
      "Subtitles only, never video. No accounts.",
      "Anonymous visit counts, no cookies.",
    ]);
    expect(footerLines(await (await app.request(path)).text())).toEqual([
      "Open source under GPL-3.0.",
      "Subtitles only, never video. No accounts.",
    ]);
  });
});

const footerLines = (text: string) =>
  [
    ...(text.match(/<footer[\s\S]*<\/footer>/)?.[0] ?? "").matchAll(
      /<p class="small">([^<]*)<\/p>/g,
    ),
  ].map((match) => match[1]);

describe("GET /stremio", () => {
  it("has a Dialogue only switch, off", async () => {
    const page = (await (await app.request("/stremio")).text()).replace(/\s+/g, " ");

    expect(page).toContain(
      '<span class="h4" id="x-dialogue">Dialogue only</span><span class="small">Also offer a copy without hearing-impaired tags like [music], (door slams) and speaker names.</span>',
    );
    expect(page).toMatch(
      /<button[^>]*role="switch"[^>]*id="dialogue-only"[^>]*aria-checked="false"[^>]*aria-labelledby="x-dialogue"/,
    );
  });

  it("has a Foreign parts only switch, off", async () => {
    const page = (await (await app.request("/stremio")).text()).replace(/\s+/g, " ");

    expect(page).toContain(
      '<span class="h4" id="x-forced">Foreign parts only</span><span class="small">For films in your language: a subtitle that shows only the lines spoken in another language, when a source has one.</span>',
    );
    expect(page).toMatch(
      /<button[^>]*role="switch"[^>]*id="foreign-parts"[^>]*aria-checked="false"[^>]*aria-labelledby="x-forced"/,
    );
  });

  it("has a Show the source in the language name switch, off", async () => {
    const page = (await (await app.request("/stremio")).text()).replace(/\s+/g, " ");

    expect(page).toContain(
      '<span class="h4" id="x-source">Show the source in the language name</span><span class="small">For TV apps that only show the language. Stremio then stops picking your language by itself.</span>',
    );
    expect(page).toMatch(
      /<button[^>]*role="switch"[^>]*id="source-in-language"[^>]*aria-checked="false"[^>]*aria-labelledby="x-source"/,
    );
  });

  it("offers an OpenSubtitles sign-in row like the Titlovi.com one", async () => {
    const page = (await (await app.request("/stremio")).text()).replace(/\s+/g, " ");

    expect(page).toContain(
      '<div class="list-row source" data-kind="opensubtitles" data-state="idle"> <div class="list-main"> <span class="h4" id="opensubtitles-name">OpenSubtitles</span><span class="small">Optional. Sign in so downloads use your own OpenSubtitles account (about 20 a day free, more with VIP).</span>',
    );
    expect(page).toMatch(
      /data-kind="opensubtitles"[\s\S]*?Sign in <\/button>[\s\S]*?<span class="status">[\s\S]*?Signed in<\/span>/,
    );
    expect(page).toMatch(/data-kind="titlovi"[\s\S]*?<span class="status">[\s\S]*?Added<\/span>/);
    expect(page).not.toContain("Ready, no account needed");
  });

  it("has a Dual subtitles switch, off, with a hidden second language choice", async () => {
    const page = (await (await app.request("/stremio")).text()).replace(/\s+/g, " ");

    expect(page).toContain(
      '<span class="h4" id="x-dual">Dual subtitles</span><span class="small">Your first language on top, a second one below, both timed to the same reference so they never drift apart.</span>',
    );
    expect(page).toMatch(
      /<button[^>]*role="switch"[^>]*id="dual"[^>]*aria-checked="false"[^>]*aria-labelledby="x-dual"/,
    );
    expect(page).toMatch(
      /<div class="row-wrap gap-12" id="dual-row" style="padding-top: 12px;" hidden> <label class="small ink-2" for="dual-lang">Second language<\/label> <select id="dual-lang" class="select">/,
    );
    expect(page).toContain('<option value="hrv">Hrvatski</option>');
  });

  it("has an Open Timings section with both switches on", async () => {
    const page = (await (await app.request("/stremio")).text()).replace(/\s+/g, " ");

    expect(page).toMatch(/<h2 class="h3" id="s5">Open Timings<\/h2>/);
    expect(page).toMatch(/<button[^>]*role="switch"[^>]*id="use-shared"[^>]*aria-checked="true"/);
    expect(page).toMatch(/<button[^>]*role="switch"[^>]*id="share"[^>]*aria-checked="true"/);
    expect(page).toContain("A shared fix from Open Timings when one exists.");
    expect(page).toContain("flagged so it is left out for everyone once another connection agrees");
  });

  it("reminds to remove the old install, hidden until an install is edited", async () => {
    const page = (await (await app.request("/stremio")).text()).replace(/\s+/g, " ");
    const reminder = "Remove the old Subs On Time in Stremio after installing this one.";

    expect(page).toContain(`<span class="small" id="edit-note" hidden>${reminder}</span>`);
    expect(page).toContain(`<p class="small" id="installed-edit-note" hidden>${reminder}</p>`);
  });

  it("lists languages by their native names", async () => {
    const page = await (await app.request("/stremio")).text();

    expect(page).toMatch(/<li[^>]*data-code="hrv"[^>]*>\s*Hrvatski\s*<\/li>/);
    expect(page).toMatch(/<li[^>]*data-code="pob"[^>]*>\s*Português \(Brasil\)\s*<\/li>/);
    expect(page).not.toContain('data-code="ger"');
  });
});

describe("GET /check", () => {
  it("marks Check a file as the current page and labels the drop zone file input", async () => {
    const page = await (await app.request("/check")).text();

    expect(page).toMatch(/<a\s+class="nav-link"\s+href="\/check"\s+aria-current="page"/);
    expect(page).toMatch(/<label class="drop"[^>]*>[\s\S]*<input[^>]*type="file"[\s\S]*<\/label>/);
    expect(page).toContain('<script type="module" src="/client/check.js"></script>');
  });
});

describe("GET /", () => {
  it("brings back the Open Timings band and what Open Timings keeps", async () => {
    const page = (await (await app.request("/")).text()).replace(/\s+/g, " ");

    expect(page).toContain(
      "Every fix is shared, so the next person with the same file gets it before the first line.",
    );
    expect(page).toContain("Fixed once. Fixed for everyone.");
    expect(page.match(/class="flow-node[ "]/g)).toHaveLength(3);
    expect(page).toContain("What Open Timings keeps");
    expect(page).toContain("Our server never reads your video.");
    expect(page).toMatch(/<a class="more" href="\/timings"/);
  });

  it("links Ko-fi from the page and the footer, in a new tab", async () => {
    const page = await (await app.request("/")).text();
    const koFi = /<a[^>]*href="https:\/\/ko-fi\.com\/jspthesixth" target="_blank" rel="noopener"/;
    const main = page.match(/<main[\s\S]*<\/main>/)?.[0] ?? "";
    const footer = page.match(/<footer[\s\S]*<\/footer>/)?.[0] ?? "";

    expect(main).toMatch(koFi);
    expect(main).toContain("Keep it free");
    expect(footer).toMatch(koFi);
    expect(page).not.toContain("github.com/sponsors");
  });

  it("links Integrations from the hero and from every library card", async () => {
    const main = (await (await app.request("/")).text()).match(/<main[\s\S]*<\/main>/)?.[0] ?? "";

    expect(main).toContain("Streaming or a library. Same fixes.");
    expect(main).toMatch(
      /<a class="btn btn-ghost btn-wide-mobile" href="\/integrations"\s*>For Sonarr, Radarr and Jellyfin<\/a/,
    );
    expect(
      main.match(/<a class="btn btn-ghost btn-sm" href="\/integrations">Set up<\/a>/g),
    ).toHaveLength(3);
  });
});

describe("GET /integrations", () => {
  const hosted = createApp({
    secret: "a-test-secret-that-is-long-enough-1234",
    publicURL: "https://subsontime.com/",
  });

  it("marks Integrations as the current page", async () => {
    const page = await (await app.request("/integrations")).text();

    expect(page).toMatch(/<a\s+class="nav-link"\s+href="\/integrations"\s+aria-current="page"/);
  });

  it("gives the Bazarr post-processing command the command line expects", async () => {
    const page = await (await hosted.request("/integrations")).text();

    expect(page).toContain(
      '<pre class="code">subsontime bazarr --video {{episode}} --subtitle {{subtitles}} --lang {{subtitles_language_code3}}</pre>',
    );
    expect(
      page.match(
        /<pre class="code">curl -fsSL https:\/\/subsontime\.com\/install\.sh \| sh<\/pre>/g,
      ),
    ).toHaveLength(2);
  });

  it("gives the Jellyfin repository on the server's own address", async () => {
    const hostedPage = await (await hosted.request("/integrations")).text();
    const selfHosted = await (
      await app.request("/integrations", {
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "subs.example.org" },
      })
    ).text();

    expect(hostedPage).toContain(
      '<pre class="code">https://subsontime.com/jellyfin/manifest.json</pre>',
    );
    expect(selfHosted).toContain(
      '<pre class="code">https://subs.example.org/jellyfin/manifest.json</pre>',
    );
  });

  it("installs the Bazarr+ provider from the zip on the latest release", async () => {
    const page = (await (await hosted.request("/integrations")).text()).replace(/\s+/g, " ");

    expect(page).toContain(
      '<a href="https://github.com/jspthesixth/subsontime/releases/latest/download/subsontime-bazarr-plus.zip" >subsontime-bazarr-plus.zip</a >',
    );
  });

  it("sends Jellyfin and Bazarr+ to the setup page for the install link", async () => {
    const page = await (await hosted.request("/integrations")).text();
    const sectionOf = (id: string) =>
      page.match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`))?.[0] ?? "";

    expect(sectionOf("jellyfin")).toMatch(/install link[\s\S]*href="\/stremio"/);
    expect(sectionOf("bazarr-plus")).toMatch(/install link[\s\S]*href="\/stremio"/);
  });
});

describe("GET /timings", () => {
  it("marks Open Timings as the current page", async () => {
    const page = await (await app.request("/timings")).text();

    expect(page).toMatch(/<a\s+class="nav-link"\s+href="\/timings"\s+aria-current="page"/);
  });

  it("exposes the lookup results as a table with column headers", async () => {
    const page = await (await app.request("/timings")).text();
    const headers = [...page.matchAll(/<span role="columnheader">([^<]+)<\/span>/g)].map(
      ([, name]) => name,
    );

    expect(page).toMatch(/role="table"/);
    expect(page).not.toMatch(/sub-head[^>]*aria-hidden/);
    expect(headers).toEqual(["Subtitle", "Lines", "Timed by", "Agreement", "Status"]);
    expect(page.match(/role="cell"/g)).toHaveLength(5);
    expect(page).not.toContain("#2A2A26");
  });
});

describe("unknown paths", () => {
  it("returns 404 for a path that is neither a page nor an install link", async () => {
    expect((await app.request("/nope")).status).toBe(404);
  });
});
