import type { ConfigForm } from "../../../config/config.ts";

export const withoutFirstAsDual = (form: ConfigForm): ConfigForm =>
  form.extras.dualLanguage === form.languages[0]
    ? { ...form, extras: { ...form.extras, dualLanguage: undefined } }
    : form;
