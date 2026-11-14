/* @ts-self-types="./alass_wasm.d.ts" */

/**
 * @param {BigInt64Array | bigint[]} reference
 * @param {BigInt64Array | bigint[]} subtitle
 * @param {number} split_penalty
 * @param {number} speed_ratio
 * @returns {BigInt64Array}
 */
function align(reference, subtitle, split_penalty, speed_ratio) {
    const val3 = +split_penalty;
    const val4 = +speed_ratio;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArray64ToWasm0(reference, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArray64ToWasm0(subtitle, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 8, 8); }
        throw e;
    }
    const ret = wasm.align(ptr0, len0, ptr1, len1, val3, val4);
    var v5 = getArrayI64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v5;
}
exports.align = align;

/**
 * @param {BigInt64Array | bigint[]} reference
 * @param {BigInt64Array | bigint[]} subtitle
 * @param {number} speed_ratio
 * @returns {bigint}
 */
function align_offset(reference, subtitle, speed_ratio) {
    const val3 = +speed_ratio;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArray64ToWasm0(reference, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArray64ToWasm0(subtitle, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 8, 8); }
        throw e;
    }
    const ret = wasm.align_offset(ptr0, len0, ptr1, len1, val3);
    return ret;
}
exports.align_offset = align_offset;

/**
 * @param {BigInt64Array | bigint[]} reference
 * @param {BigInt64Array | bigint[]} subtitle
 * @returns {number}
 */
function score(reference, subtitle) {
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArray64ToWasm0(reference, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArray64ToWasm0(subtitle, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 8, 8); }
        throw e;
    }
    const ret = wasm.score(ptr0, len0, ptr1, len1);
    return ret;
}
exports.score = score;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./alass_wasm_bg.js": import0,
    };
}

function getArrayI64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getBigInt64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedBigInt64ArrayMemory0 = null;
function getBigInt64ArrayMemory0() {
    if (cachedBigInt64ArrayMemory0 === null || cachedBigInt64ArrayMemory0.byteLength === 0) {
        cachedBigInt64ArrayMemory0 = new BigInt64Array(wasm.memory.buffer);
    }
    return cachedBigInt64ArrayMemory0;
}

let cachedBigUint64ArrayMemory0 = null;
function getBigUint64ArrayMemory0() {
    if (cachedBigUint64ArrayMemory0 === null || cachedBigUint64ArrayMemory0.byteLength === 0) {
        cachedBigUint64ArrayMemory0 = new BigUint64Array(wasm.memory.buffer);
    }
    return cachedBigUint64ArrayMemory0;
}

function passArray64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getBigUint64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/alass_wasm_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
