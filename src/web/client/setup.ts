import { renderSVG } from "uqr";
import type { Config, SourceSettings } from "../../config/config.ts";
import { defaultConfig, openSubtitlesAddonURL } from "../../config/default-config.ts";
import { fromLocales } from "../../languages.ts";
import { searchKey } from "../search-key.ts";

type Form = Omit<Config, "version" | "installId">;
type Account = Exclude<SourceSettings, { kind: "stremio-addon" }>;
type Installed = { installURL: string; stremioURL: string; webURL: string };
type Outcome = { result: unknown } | { error: string };

const unreachableMessage = "Could not reach Subs On Time. Try again.";
const copiedDuration = 2000;

const find = <T extends Element = HTMLElement>(root: ParentNode, selector: string) => {
  const element = root.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`Missing ${selector}`);
  }

  return element;
};

const clone = (templateId: string) =>
  find<HTMLTemplateElement>(document, templateId).content.cloneNode(true) as DocumentFragment;

const chosen = find(document, "#chosen-languages");
const search = find<HTMLInputElement>(document, "#lang-search");
const listbox = find(document, "#lang-options");
const options = [...listbox.querySelectorAll<HTMLElement>("[role=option]")];
const bestOnlyInput = find<HTMLInputElement>(document, "#best-only");
const timingInputs = [...document.querySelectorAll<HTMLInputElement>("input[name=timing]")];
const hideMismatchesSwitch = find(document, "#hide-mismatches");
const sourceList = find(document, "#source-list");
const accountRows = [...sourceList.querySelectorAll<HTMLElement>(".source")];
const addonForm = find<HTMLFormElement>(document, "#addon-form");
const addonInput = find<HTMLInputElement>(document, "#addon-url");
const summary = find(document, "#install-summary");
const installError = find(document, "#install-error");
const installButton = find<HTMLButtonElement>(document, "#install");
const editButton = find(document, "#edit-install");
const editForm = find<HTMLFormElement>(document, "#edit-form");
const editLink = find<HTMLInputElement>(document, "#edit-link");

const isOpenSubtitles = (source: SourceSettings) =>
  source.kind === "stremio-addon" && source.url === openSubtitlesAddonURL;

const formOf = ({ languages, bestOnly, timing, sources, extras }: Form): Form => ({
  languages,
  bestOnly,
  timing,
  sources: [
    { kind: "stremio-addon", url: openSubtitlesAddonURL },
    ...sources.filter((source) => !isOpenSubtitles(source)),
  ],
  extras,
});

let state = formOf(defaultConfig(fromLocales(navigator.languages)));
let activeOption: HTMLElement | undefined;

const nameOf = (code: string) =>
  options.find((option) => option.dataset["code"] === code)?.textContent?.trim() ?? code;

const addonURLs = () =>
  state.sources.flatMap((source) =>
    source.kind === "stremio-addon" && !isOpenSubtitles(source) ? [source.url] : [],
  );

const summaryOf = ({ languages, sources, timing }: Form) =>
  [
    languages.map(nameOf).join(", "),
    `${sources.length} ${sources.length === 1 ? "source" : "sources"}`,
    timing === "auto" ? "Automatic timing" : "Timing off",
  ]
    .filter((part) => part !== "")
    .join(" · ");

const errorOf = (result: unknown) =>
  typeof result === "object" &&
  result !== null &&
  "error" in result &&
  typeof result.error === "string"
    ? result.error
    : unreachableMessage;

const checkErrorOf = (result: unknown) =>
  typeof result === "object" && result !== null && "ok" in result && result.ok === true
    ? undefined
    : errorOf(result);

const postJSON = async (path: string, body: unknown): Promise<Outcome> => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
  const result: unknown = await response?.json().catch(() => undefined);

  return response?.ok === true ? { result } : { error: errorOf(result) };
};

const update = (changes: Partial<Form>) => {
  state = { ...state, ...changes };
  render();
};

const visibleOptions = () => options.filter((option) => !option.hidden);

const setActiveOption = (option: HTMLElement | undefined) => {
  activeOption = option;
  options.forEach((each) => each.setAttribute("aria-selected", String(each === option)));
  search.setAttribute("aria-activedescendant", option?.id ?? "");
  option?.scrollIntoView({ block: "nearest" });
};

const filterOptions = () => {
  const query = searchKey(search.value.trim());

  options.forEach((option) => {
    option.hidden =
      state.languages.includes(option.dataset["code"] ?? "") ||
      !(option.dataset["search"] ?? "").includes(query);
  });
};

const setListOpen = (open: boolean) => {
  const shown = open && visibleOptions().length > 0;

  listbox.hidden = !shown;
  search.setAttribute("aria-expanded", String(shown));
  setActiveOption(shown ? visibleOptions()[0] : undefined);
};

const moveActiveOption = (step: number) => {
  const visible = visibleOptions();
  const index = activeOption === undefined ? -1 : visible.indexOf(activeOption);

  setActiveOption(visible[(index + step + visible.length) % visible.length]);
};

const addLanguage = (code: string | undefined) => {
  if (code === undefined || state.languages.includes(code)) {
    return;
  }

  search.value = "";
  update({ languages: [...state.languages, code] });
  setListOpen(false);
};

const chipFor = (code: string, index: number) => {
  const chip = clone("#chip-template");
  const remove = find(chip, ".x");

  find(chip, ".n").textContent = String(index + 1);
  find(chip, ".chip-name").textContent = nameOf(code);
  remove.setAttribute("aria-label", `Remove ${nameOf(code)}`);
  remove.addEventListener("click", () => {
    update({ languages: state.languages.filter((each) => each !== code) });
    search.focus();
  });

  return chip;
};

const addonRowFor = (url: string) => {
  const row = clone("#addon-template");
  const host = URL.canParse(url) ? new URL(url).host : url;
  const remove = find(row, ".addon-remove");

  find(row, ".addon-host").textContent = host;
  find(row, ".addon-url").textContent = url;
  remove.setAttribute("aria-label", `Remove ${host}`);
  remove.addEventListener("click", () => {
    update({ sources: state.sources.filter((source) => !("url" in source && source.url === url)) });
    addonInput.focus();
  });

  return row;
};

const renderAccountRow = (row: HTMLElement) => {
  const saved = state.sources.some((source) => source.kind === row.dataset["kind"]);

  if (saved) {
    row.dataset["state"] = "saved";
  } else if (row.dataset["state"] === "saved") {
    row.dataset["state"] = "idle";
  }
};

const render = () => {
  chosen.replaceChildren(...state.languages.map(chipFor));
  filterOptions();
  bestOnlyInput.checked = state.bestOnly;
  timingInputs.forEach((input) => {
    input.checked = input.value === state.timing;
  });
  hideMismatchesSwitch.setAttribute("aria-checked", String(state.extras.hideMismatches));
  accountRows.forEach(renderAccountRow);
  sourceList.querySelectorAll(".addon-row").forEach((row) => row.remove());
  sourceList.append(...addonURLs().map(addonRowFor));
  summary.textContent = summaryOf(state);
};

const showInstalled = ({ installURL, stremioURL, webURL }: Installed) => {
  const view = clone("#installed-template");
  const heading = find(document, "h1");
  const link = find<HTMLInputElement>(view, "#install-link");
  const copyLabel = find(view, "#copy-label");

  find(view, "#installed-summary").textContent = summaryOf(state);
  find(view, "#installed-summary").after(heading);
  heading.textContent = "Subs On Time is ready.";
  find<HTMLAnchorElement>(view, "#open-stremio").href = stremioURL;
  find<HTMLAnchorElement>(view, "#stremio-web").href = webURL;
  link.value = installURL;
  find(view, "#install-qr").innerHTML = renderSVG(installURL, {
    whiteColor: "#F4F3EE",
    blackColor: "#0D0D0C",
  });
  find(view, "#copy-link").addEventListener("click", () => {
    link.select();
    navigator.clipboard.writeText(installURL).then(
      () => {
        copyLabel.textContent = "Copied";
        setTimeout(() => {
          copyLabel.textContent = "Copy";
        }, copiedDuration);
      },
      () => undefined,
    );
  });
  find(document, "#setup").replaceWith(view);
  find(document, "#install-bar").remove();
  document.title = "Subs On Time is ready";
  window.scrollTo(0, 0);
  heading.focus();
};

search.addEventListener("input", () => {
  filterOptions();
  setListOpen(true);
});

search.addEventListener("click", () => setListOpen(true));

search.addEventListener("blur", () => setListOpen(false));

search.addEventListener("keydown", (event) => {
  const open = !listbox.hidden;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();

    if (open) {
      moveActiveOption(event.key === "ArrowDown" ? 1 : -1);
    } else {
      setListOpen(true);
    }
  }

  if (event.key === "Enter" && open) {
    event.preventDefault();
    addLanguage(activeOption?.dataset["code"]);
  }

  if (event.key === "Escape" && open) {
    event.preventDefault();
    setListOpen(false);
  }
});

listbox.addEventListener("mousedown", (event) => event.preventDefault());

listbox.addEventListener("click", (event) => {
  const option =
    event.target instanceof Element ? event.target.closest<HTMLElement>("[role=option]") : null;

  addLanguage(option?.dataset["code"]);
});

bestOnlyInput.addEventListener("change", () => update({ bestOnly: bestOnlyInput.checked }));

timingInputs.forEach((input) =>
  input.addEventListener("change", () =>
    update({ timing: input.value === "off" ? "off" : "auto" }),
  ),
);

hideMismatchesSwitch.addEventListener("click", () =>
  update({ extras: { hideMismatches: !state.extras.hideMismatches } }),
);

accountRows.forEach((row) => {
  const kind = row.dataset["kind"];
  const form = find<HTMLFormElement>(row, "form");
  const add = find(row, ".source-add");
  const submit = find<HTMLButtonElement>(form, "[type=submit]");
  const error = find(form, ".source-error");
  const others = () => state.sources.filter((source) => source.kind !== kind);

  const setEditing = (editing: boolean) => {
    row.dataset["state"] = editing ? "editing" : "idle";
    error.textContent = "";
    add.setAttribute("aria-expanded", String(editing));
  };

  add.addEventListener("click", () => {
    setEditing(true);
    find(form, "input").focus();
  });

  find(row, ".source-cancel").addEventListener("click", () => {
    form.reset();
    setEditing(false);
    add.focus();
  });

  form.addEventListener("submit", async (event) => {
    const account = { kind, ...Object.fromEntries(new FormData(form)) } as Account;

    event.preventDefault();
    error.textContent = "";
    submit.disabled = true;

    const outcome = await postJSON("/api/sources/check", account);
    const problem = "error" in outcome ? outcome.error : checkErrorOf(outcome.result);

    submit.disabled = false;

    if (problem !== undefined) {
      error.textContent = problem;
      submit.focus();

      return;
    }

    form.reset();
    add.setAttribute("aria-expanded", "false");
    update({ sources: [...others(), account] });
    find(row, ".source-remove").focus();
  });

  find(row, ".source-remove").addEventListener("click", () => {
    update({ sources: others() });
    add.focus();
  });
});

addonForm.addEventListener("submit", (event) => {
  const url = addonInput.value.trim();

  event.preventDefault();
  addonForm.reset();

  if (!addonURLs().includes(url)) {
    update({ sources: [...state.sources, { kind: "stremio-addon", url }] });
  }
});

installButton.addEventListener("click", async () => {
  installError.textContent = "";
  installButton.disabled = true;

  const outcome = await postJSON("/api/config", state);

  installButton.disabled = false;
  installButton.focus();

  if ("error" in outcome) {
    installError.textContent = outcome.error;

    return;
  }

  showInstalled(outcome.result as Installed);
});

editButton.addEventListener("click", () => {
  editForm.hidden = !editForm.hidden;
  editButton.setAttribute("aria-expanded", String(!editForm.hidden));

  if (!editForm.hidden) {
    editLink.focus();
  }
});

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  installError.textContent = "";

  const outcome = await postJSON("/api/config/open", { installURL: editLink.value });

  if ("error" in outcome) {
    installError.textContent = outcome.error;

    return;
  }

  state = formOf(outcome.result as Form);
  render();
  editForm.reset();
  editForm.hidden = true;
  editButton.setAttribute("aria-expanded", "false");
  editButton.focus();
});

render();
