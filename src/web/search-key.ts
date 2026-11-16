export const searchKey = (text: string) =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
