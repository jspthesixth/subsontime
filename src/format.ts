const sizeUnits: [string, number][] = [
  ["GB", 1e9],
  ["MB", 1e6],
];

export const sizeText = (bytes: number) => {
  const [unit, scale] = sizeUnits.find(([, each]) => bytes >= each) ?? ["KB", 1e3];

  return `${(bytes / scale).toFixed(2)} ${unit}`;
};

export const seconds = (ms: number) => `${ms < 0 ? "-" : "+"}${Math.abs(ms / 1000).toFixed(2)} s`;

const fpsText = (fps: number) => String(Number(fps.toFixed(3)));

export const speedText = (ratio: number, fps: number | undefined) =>
  fps === undefined ? `×${ratio.toFixed(4)}` : `${fpsText(fps)} to ${fpsText(fps * ratio)}`;
