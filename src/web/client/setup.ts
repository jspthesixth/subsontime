import { renderSVG } from "uqr";
import type { ConfigForm, SourceSettings } from "../../config/config.ts";
import { defaultForm, formOf, openSubtitlesAddonURL } from "../../config/default-config.ts";
import { fromLocales } from "../../languages.ts";
import { searchKey } from "../search-key.ts";
import { combobox } from "./lib/combobox.ts";
import { withoutFirstAsDual } from "./lib/dual-language.ts";
import { clone, find } from "./lib/dom.ts";
import { installLinkOf } from "./lib/install-link.ts";
import { move } from "./lib/move.ts";
import { errorOf, postJSON } from "./lib/post-json.ts";

type Account = Exclude<SourceSettings, { kind: "stremio-addon" }>;
type Installed = { installURL: string; stremioURL: string; webURL: string };

const copiedDuration = 2000;
const canDrag = matchMedia("(hover: hover) and (pointer: fine)").matches;

const chosen = find(document, "#chosen-languages");
const search = find<HTMLInputElement>(document, "#lang-search");
const listbox = find(document, "#lang-options");
const options = [...listbox.querySelectorAll<HTMLElement>("[role=option]")];
const bestOnlyInput = find<HTMLInputElement>(document, "#best-only");
const timingInputs = [...document.querySelectorAll<HTMLInputElement>("input[name=timing]")];
const hideMismatchesSwitch = find(document, "#hide-mismatches");
const dialogueOnlySwitch = find(document, "#dialogue-only");
const foreignPartsSwitch = find(document, "#foreign-parts");
const dualSwitch = find(document, "#dual");
const dualRow = find(document, "#dual-row");
const dualSelect = find<HTMLSelectElement>(document, "#dual-lang");
const useSharedSwitch = find(document, "#use-shared");
const shareSwitch = find(document, "#share");
const sourceList = find(document, "#source-list");
const accountRows = [...sourceList.querySelectorAll<HTMLElement>(".source")];
const addonForm = find<HTMLFormElement>(document, "#addon-form");
const addonInput = find<HTMLInputElement>(document, "#addon-url");
const summary = find(document, "#install-summary");
const editNote = find(document, "#edit-note");
const installError = find(document, "#install-error");
const installButton = find<HTMLButtonElement>(document, "#install");
const editButton = find(document, "#edit-install");
const editForm = find<HTMLFormElement>(document, "#edit-form");
const editLink = find<HTMLInputElement>(document, "#edit-link");

const languageCombo = combobox(search, listbox, (option) => addLanguage(option.dataset["code"]));

const isOpenSubtitles = (source: SourceSettings) =>
  source.kind === "stremio-addon" && source.url === openSubtitlesAddonURL;

const withOpenSubtitles = (form: ConfigForm): ConfigForm => ({
  ...formOf(form),
  sources: [
    { kind: "stremio-addon", url: openSubtitlesAddonURL },
    ...form.sources.filter((source) => !isOpenSubtitles(source)),
  ],
});

let state = defaultForm(fromLocales(navigator.languages));
let openedInstall: string | undefined;

const nameOf = (code: string) =>
  options.find((option) => option.dataset["code"] === code)?.textContent?.trim() ?? code;

const addonURLs = () =>
  state.sources.flatMap((source) =>
    source.kind === "stremio-addon" && !isOpenSubtitles(source) ? [source.url] : [],
  );

const summaryOf = ({ languages, sources, timing }: ConfigForm) =>
  [
    languages.map(nameOf).join(", "),
    `${sources.length} ${sources.length === 1 ? "source" : "sources"}`,
    timing === "auto" ? "Automatic timing" : "Timing off",
  ]
    .filter((part) => part !== "")
    .join(" · ");

const checkErrorOf = (result: unknown) =>
  typeof result === "object" && result !== null && "ok" in result && result.ok === true
    ? undefined
    : errorOf(result);

const update = (changes: Partial<ConfigForm>) => {
  state = withoutFirstAsDual({ ...state, ...changes });
  render();
};

const filterOptions = () => {
  const query = searchKey(search.value.trim());

  options.forEach((option) => {
    option.hidden =
      state.languages.includes(option.dataset["code"] ?? "") ||
      !(option.dataset["search"] ?? "").includes(query);
  });
};

const addLanguage = (code: string | undefined) => {
  if (code === undefined || state.languages.includes(code)) {
    return;
  }

  search.value = "";
  update({ languages: [...state.languages, code] });
  languageCombo.setOpen(false);
};

const moveLanguage = (from: number, to: number) => {
  update({ languages: move(state.languages, from, to) });
};

const chipFor = (code: string, index: number) => {
  const fragment = clone("#chip-template");
  const chip = find(fragment, ".chip");
  const earlier = find(chip, ".move");
  const remove = find(chip, ".remove");

  find(chip, ".n").textContent = String(index + 1);
  find(chip, ".chip-name").textContent = nameOf(code);
  remove.setAttribute("aria-label", `Remove ${nameOf(code)}`);
  remove.addEventListener("click", () => {
    update({ languages: state.languages.filter((each) => each !== code) });
    search.focus();
  });

  if (index === 0) {
    earlier.remove();
  }

  earlier.setAttribute("aria-label", `Move ${nameOf(code)} earlier`);
  earlier.addEventListener("click", () => {
    moveLanguage(index, index - 1);
    find(chosen, `.chip:nth-child(${index}) ${index === 1 ? ".remove" : ".move"}`).focus();
  });
  chip.draggable = canDrag;
  chip.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("text/plain", code);
  });
  chip.addEventListener("dragover", (event) => event.preventDefault());
  chip.addEventListener("drop", (event) => {
    const from = state.languages.indexOf(event.dataTransfer?.getData("text/plain") ?? "");

    event.preventDefault();

    if (from !== -1) {
      moveLanguage(from, index);
    }
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
  dialogueOnlySwitch.setAttribute("aria-checked", String(state.extras.dialogueOnly));
  foreignPartsSwitch.setAttribute("aria-checked", String(state.extras.foreignParts));
  dualSwitch.setAttribute("aria-checked", String(state.extras.dualLanguage !== undefined));
  dualRow.hidden = state.extras.dualLanguage === undefined;
  [...dualSelect.options].forEach((option) => {
    option.disabled = option.value === state.languages[0];
  });
  dualSelect.value = state.extras.dualLanguage ?? "";
  useSharedSwitch.setAttribute("aria-checked", String(state.useShared));
  shareSwitch.setAttribute("aria-checked", String(state.share));
  accountRows.forEach(renderAccountRow);
  sourceList.querySelectorAll(".addon-row").forEach((row) => row.remove());
  sourceList.append(...addonURLs().map(addonRowFor));
  summary.textContent = summaryOf(state);
  editNote.hidden = openedInstall === undefined;
};

const openInstall = async (installURL: string) => {
  installError.textContent = "";

  const outcome = await postJSON("/api/config/open", { installURL });

  if ("error" in outcome) {
    installError.textContent = outcome.error;

    return false;
  }

  state = withOpenSubtitles(outcome.result as ConfigForm);
  openedInstall = installURL;
  render();

  return true;
};

const showInstalled = ({ installURL, stremioURL, webURL }: Installed) => {
  const view = clone("#installed-template");
  const heading = find(document, "h1");
  const link = find<HTMLInputElement>(view, "#install-link");
  const copyLabel = find(view, "#copy-label");

  find(view, "#installed-summary").textContent = summaryOf(state);
  find(view, "#installed-edit-note").hidden = openedInstall === undefined;
  find(view, "#installed-summary").after(heading);
  heading.textContent = "Subs On Time is ready.";
  find<HTMLAnchorElement>(view, "#open-stremio").href = stremioURL;
  find<HTMLAnchorElement>(view, "#stremio-web").href = webURL;
  link.value = installURL;
  find(view, "#install-qr").innerHTML = renderSVG(stremioURL, {
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
  languageCombo.setOpen(true);
});

bestOnlyInput.addEventListener("change", () => update({ bestOnly: bestOnlyInput.checked }));

timingInputs.forEach((input) =>
  input.addEventListener("change", () =>
    update({ timing: input.value === "off" ? "off" : "auto" }),
  ),
);

hideMismatchesSwitch.addEventListener("click", () =>
  update({ extras: { ...state.extras, hideMismatches: !state.extras.hideMismatches } }),
);

dialogueOnlySwitch.addEventListener("click", () =>
  update({ extras: { ...state.extras, dialogueOnly: !state.extras.dialogueOnly } }),
);

foreignPartsSwitch.addEventListener("click", () =>
  update({ extras: { ...state.extras, foreignParts: !state.extras.foreignParts } }),
);

dualSwitch.addEventListener("click", () =>
  update({
    extras: {
      ...state.extras,
      dualLanguage:
        state.extras.dualLanguage === undefined
          ? (state.languages[1] ??
            [...dualSelect.options].find((option) => !option.disabled)?.value)
          : undefined,
    },
  }),
);

dualSelect.addEventListener("change", () =>
  update({ extras: { ...state.extras, dualLanguage: dualSelect.value } }),
);

useSharedSwitch.addEventListener("click", () => update({ useShared: !state.useShared }));

shareSwitch.addEventListener("click", () => update({ share: !state.share }));

accountRows.forEach((row) => {
  const kind = row.dataset["kind"];
  const form = find<HTMLFormElement>(row, "form");
  const add = find(row, ".source-add");
  const submit = find<HTMLButtonElement>(form, "[type=submit]");
  const error = find(form, ".source-error");
  const others = () => state.sources.filter((source) => source.kind !== kind);
  let attempt = 0;

  const setEditing = (editing: boolean) => {
    attempt += 1;
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

    const current = attempt;

    event.preventDefault();
    error.textContent = "";
    submit.disabled = true;

    const outcome = await postJSON("/api/sources/check", account);
    const problem = "error" in outcome ? outcome.error : checkErrorOf(outcome.result);

    submit.disabled = false;

    if (current !== attempt) {
      return;
    }

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

  const outcome = await postJSON("/api/config", { ...state, installURL: openedInstall });

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

  if (!(await openInstall(editLink.value))) {
    return;
  }

  editForm.reset();
  editForm.hidden = true;
  editButton.setAttribute("aria-expanded", "false");
  editButton.focus();
});

const configureLink = installLinkOf(location.hash, location.origin);

if (configureLink !== undefined) {
  history.replaceState(null, "", location.pathname + location.search);
  void openInstall(configureLink);
}

render();
