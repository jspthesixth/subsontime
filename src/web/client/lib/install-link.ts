export const installLinkOf = (hash: string, origin: string) => {
  const sealed = new URLSearchParams(hash.slice(1)).get("config");

  return sealed === null || sealed === "" ? undefined : `${origin}/${sealed}/manifest.json`;
};
