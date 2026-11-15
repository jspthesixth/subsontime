import { seededRandom } from "./test-tracks.ts";

export const sampleRate = 16000;
const fundamental = 140;
const formants = [
  { frequency: 700, gain: 1 },
  { frequency: 1200, gain: 0.6 },
  { frequency: 2500, gain: 0.3 },
];

const harmonicGain = (frequency: number) =>
  formants
    .map((formant) => formant.gain / (1 + ((frequency - formant.frequency) / 150) ** 2))
    .reduce((sum, gain) => sum + gain, 0);

const harmonics = Array.from({ length: 25 }, (_, index) => ({
  multiple: index + 1,
  gain: harmonicGain(fundamental * (index + 1)),
}));

const voiced = (time: number) => {
  const phase =
    2 *
    Math.PI *
    (fundamental * time - (30 / (2 * Math.PI * 3)) * (Math.cos(2 * Math.PI * 3 * time) - 1));
  const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * time);

  return (
    harmonics
      .map((harmonic) => Math.sin(phase * harmonic.multiple) * harmonic.gain)
      .reduce((sum, value) => sum + value, 0) *
    0.3 *
    envelope *
    8000
  );
};

const samples = (ms: number) => Math.round((ms * sampleRate) / 1000);

export const burst = (ms: number) =>
  Int16Array.from({ length: samples(ms) }, (_, index) => voiced(index / sampleRate));

export const silence = (ms: number) => new Int16Array(samples(ms));

export const concat = (parts: Int16Array[]) => {
  const joined = new Int16Array(parts.reduce((length, part) => length + part.length, 0));

  parts.reduce((offset, part) => {
    joined.set(part, offset);

    return offset + part.length;
  }, 0);

  return joined;
};

export const chunked = async function* (pcm: Int16Array, size: number) {
  for (let offset = 0; offset < pcm.length; offset += size) {
    yield pcm.subarray(offset, offset + size);
  }
};

export const once = async function* (pcm: Int16Array) {
  yield pcm;
};

export const tone = (ms: number, frequency: number, amplitude: number) =>
  Int16Array.from({ length: samples(ms) }, (_, index) =>
    Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude),
  );

export const whiteNoise = (ms: number, amplitude: number, seed: number) => {
  const random = seededRandom(seed);

  return Int16Array.from({ length: samples(ms) }, () => Math.round((random() * 2 - 1) * amplitude));
};

export const rms = (pcm: Int16Array) =>
  Math.sqrt(pcm.reduce((sum, sample) => sum + sample * sample, 0) / pcm.length);
