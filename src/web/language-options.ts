import { englishNameOf, languageCodes, toISO6391 } from "../languages.ts";
import { searchKey } from "./search-key.ts";

const nativeName = (code6391: string) => {
  const name = new Intl.DisplayNames([code6391], { type: "language" }).of(code6391) ?? code6391;

  return name.charAt(0).toLocaleUpperCase(code6391) + name.slice(1);
};

export const languageOptions = languageCodes
  .map((code) => {
    const code6391 = toISO6391(code) ?? code;
    const name = nativeName(code6391);

    return { code, name, search: searchKey(`${name} ${englishNameOf(code)} ${code}`) };
  })
  .toSorted((first, second) => first.name.localeCompare(second.name, "en"));
