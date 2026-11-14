export const searchKey = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
