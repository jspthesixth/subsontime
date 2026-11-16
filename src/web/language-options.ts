import { englishNameOf, languageCodes, nativeNameOf } from "../languages.ts";
import { searchKey } from "./search-key.ts";

export const languageOptions = languageCodes
  .map((code) => {
    const name = nativeNameOf(code);

    return { code, name, search: searchKey(`${name} ${englishNameOf(code)} ${code}`) };
  })
  .toSorted((first, second) => first.name.localeCompare(second.name, "en"));
