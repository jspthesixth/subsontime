export const languageCodes = [
  "hrv",
  "srp",
  "bos",
  "slv",
  "mkd",
  "eng",
  "deu",
  "fra",
  "spa",
  "ita",
  "por",
  "pob",
  "nld",
  "pol",
  "ces",
  "slk",
  "hun",
  "ron",
  "bul",
  "rus",
  "ukr",
  "ell",
  "tur",
  "ara",
  "heb",
  "fas",
  "zho",
  "zht",
  "jpn",
  "kor",
  "swe",
  "nor",
  "dan",
  "fin",
];

const sourceCodes: Record<string, string> = { pob: "pt-br", zht: "zh-tw" };

const regionalDefaults: Record<string, string> = { pt: "pt-pt", zh: "zh-cn" };

const canonical = (code6392: string) => {
  const [base = code6392] = Intl.getCanonicalLocales(code6392);

  return sourceCodes[code6392] ?? regionalDefaults[base] ?? base;
};

const to6392 = new Map(languageCodes.map((code) => [canonical(code), code]));

export const toISO6391 = (code6392: string) => {
  const lower = code6392.toLowerCase();

  if (!/^[a-z]{3}$/.test(lower)) {
    return undefined;
  }

  const code6391 = canonical(lower);

  return to6392.has(code6391) ? code6391 : undefined;
};

const englishNames = new Intl.DisplayNames(["en"], { type: "language" });

export const englishNameOf = (code6392: string) =>
  englishNames.of(toISO6391(code6392) ?? code6392) ?? code6392;

export const toISO6392 = (code6391: string) => to6392.get(code6391.toLowerCase());

export const fromLocales = (locales: readonly string[]) => {
  const codes = locales.flatMap((locale) => {
    const code = toISO6392(locale) ?? toISO6392(locale.split("-")[0] ?? "");

    return code === undefined ? [] : [code];
  });

  return codes.length === 0 ? ["eng"] : [...new Set(codes)];
};
