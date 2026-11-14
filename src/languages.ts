const pairs: [string, string][] = [
  ["hrv", "hr"],
  ["srp", "sr"],
  ["bos", "bs"],
  ["slv", "sl"],
  ["mkd", "mk"],
  ["eng", "en"],
  ["deu", "de"],
  ["ger", "de"],
  ["fra", "fr"],
  ["fre", "fr"],
  ["spa", "es"],
  ["ita", "it"],
  ["por", "pt-pt"],
  ["pob", "pt-br"],
  ["nld", "nl"],
  ["dut", "nl"],
  ["pol", "pl"],
  ["ces", "cs"],
  ["cze", "cs"],
  ["slk", "sk"],
  ["slo", "sk"],
  ["hun", "hu"],
  ["ron", "ro"],
  ["rum", "ro"],
  ["bul", "bg"],
  ["rus", "ru"],
  ["ukr", "uk"],
  ["ell", "el"],
  ["gre", "el"],
  ["tur", "tr"],
  ["ara", "ar"],
  ["heb", "he"],
  ["fas", "fa"],
  ["per", "fa"],
  ["zho", "zh-cn"],
  ["chi", "zh-cn"],
  ["zht", "zh-tw"],
  ["jpn", "ja"],
  ["kor", "ko"],
  ["swe", "sv"],
  ["nor", "no"],
  ["dan", "da"],
  ["fin", "fi"],
];

const to6391 = new Map(pairs);
const to6392 = new Map(pairs.toReversed().map(([code6392, code6391]) => [code6391, code6392]));

export const toISO6391 = (code6392: string) => to6391.get(code6392.toLowerCase());

export const toISO6392 = (code6391: string) => to6392.get(code6391.toLowerCase());

export const languageCodes = pairs
  .filter(([code6392, code6391]) => toISO6392(code6391) === code6392)
  .map(([code6392]) => code6392);

export const fromLocales = (locales: readonly string[]) => {
  const codes = locales.flatMap((locale) => {
    const code = toISO6392(locale) ?? toISO6392(locale.split("-")[0] ?? "");

    return code === undefined ? [] : [code];
  });

  return codes.length === 0 ? ["eng"] : [...new Set(codes)];
};
