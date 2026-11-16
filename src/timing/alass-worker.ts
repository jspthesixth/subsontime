import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

type Call = "align" | "align_offset" | "score";
type Waiting = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const wasmPath = createRequire(import.meta.url).resolve("../../wasm/alass_wasm.js");

const source = `
const { parentPort, workerData } = require("node:worker_threads");
const wasm = require(workerData.wasmPath);

parentPort.on("message", ({ id, call, args }) => {
  try {
    parentPort.postMessage({ id, result: wasm[call](...args) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error) });
  }
});
`;

const waiting = new Map<number, Waiting>();
let worker: Worker | undefined;
let nextId = 0;

const failAll = (error: Error) => {
  for (const { reject } of waiting.values()) {
    reject(error);
  }

  waiting.clear();
  worker = undefined;
};

const settle = ({ id, result, error }: { id: number; result?: unknown; error?: string }) => {
  const entry = waiting.get(id);

  waiting.delete(id);

  if (waiting.size === 0) {
    worker?.unref();
  }

  if (error === undefined) {
    entry?.resolve(result);
  } else {
    entry?.reject(new Error(error));
  }
};

const workerOf = () => {
  if (worker !== undefined) {
    return worker;
  }

  const started = new Worker(source, { eval: true, workerData: { wasmPath } });

  started.on("message", settle);
  started.on("error", failAll);
  started.on("exit", () => failAll(new Error("The alignment worker stopped")));
  worker = started;

  return started;
};

export const inWorker = <T>(call: Call, ...args: unknown[]) =>
  new Promise<T>((resolve, reject) => {
    const id = nextId;
    const running = workerOf();

    nextId += 1;
    waiting.set(id, { resolve: (value) => resolve(value as T), reject });
    running.ref();
    running.postMessage({ id, call, args }, []);
  });
