import { describe, expect, it } from "vitest";
import { detectSpeech } from "./speech.ts";
import { burst, concat, sampleRate, silence } from "./test-audio.ts";

const chunk = concat([burst(1000), silence(1048)]);
const threeHours = 3 * 60 * 60 * sampleRate;

const threeHoursOfChunks = async function* () {
  for (let sent = 0; sent < threeHours; sent += chunk.length) {
    yield chunk;
  }
};

describe("detectSpeech", () => {
  it("detects speech in 3 hours of 16 kHz audio pushed in 64 KB chunks in under 20 s", async () => {
    const started = performance.now();

    await detectSpeech(threeHoursOfChunks(), sampleRate);

    expect(performance.now() - started).toBeLessThan(20_000);
  }, 60_000);
});
