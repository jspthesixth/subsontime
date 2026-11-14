const sizeUnits: [string, number][] = [
  ["GB", 1e9],
  ["MB", 1e6],
];

export const sizeText = (bytes: number) => {
  const [unit, scale] = sizeUnits.find(([, each]) => bytes >= each) ?? ["KB", 1e3];

  return `${(bytes / scale).toFixed(2)} ${unit}`;
};
