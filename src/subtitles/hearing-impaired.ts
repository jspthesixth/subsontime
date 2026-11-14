const soundDescriptions = /\[[^\]]*\]|\([^)]*\)/g;
const speakerLabel = /^(\s*-\s*)?\p{Lu}{2}[\p{Lu}\p{N} .'-]*:\s*/u;
const emptyLine = /^[\s♪♫#-]*$/;

export const stripSoundDescriptions = (text: string): string =>
  text
    .replace(soundDescriptions, "")
    .split("\n")
    .map((line) => line.replace(speakerLabel, "$1").replace(/\s+/g, " ").trim())
    .filter((line) => !emptyLine.test(line))
    .join("\n");
