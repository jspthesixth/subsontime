/* tslint:disable */
/* eslint-disable */

export class SpeechDetector {
    free(): void;
    [Symbol.dispose](): void;
    finish(): BigInt64Array;
    constructor(sample_rate: number);
    push(samples: Int16Array | number[]): void;
}

export function align(reference: BigInt64Array | bigint[], subtitle: BigInt64Array | bigint[], split_penalty: number, speed_ratio: number): BigInt64Array;

export function align_offset(reference: BigInt64Array | bigint[], subtitle: BigInt64Array | bigint[], speed_ratio: number): bigint;

export function score(reference: BigInt64Array | bigint[], subtitle: BigInt64Array | bigint[], within_reference: boolean): number;
