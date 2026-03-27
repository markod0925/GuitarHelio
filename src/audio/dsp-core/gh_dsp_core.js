/* @ts-self-types="./gh_dsp_core.d.ts" */

/**
 * @enum {0 | 1}
 */
export const DspMode = Object.freeze({
    Speaker: 0, "0": "Speaker",
    Headphones: 1, "1": "Headphones",
});

export class GhDspCore {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GhDspCoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ghdspcore_free(ptr, 0);
    }
    constructor() {
        const ret = wasm.ghdspcore_new();
        this.__wbg_ptr = ret >>> 0;
        GhDspCoreFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} sample_rate
     * @param {number} block_size
     * @param {DspMode} mode
     */
    prepare(sample_rate, block_size, mode) {
        wasm.ghdspcore_prepare(this.__wbg_ptr, sample_rate, block_size, mode);
    }
    /**
     * @param {Float32Array} mic_block
     * @returns {any}
     */
    process_block(mic_block) {
        const ptr0 = passArrayF32ToWasm0(mic_block, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ghdspcore_process_block(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    reset() {
        wasm.ghdspcore_reset(this.__wbg_ptr);
    }
    /**
     * @param {PitchDetectorPreset} preset
     */
    set_pitch_detector_preset(preset) {
        wasm.ghdspcore_set_pitch_detector_preset(this.__wbg_ptr, preset);
    }
    /**
     * @param {Float32Array} reference_block
     */
    set_reference_block(reference_block) {
        const ptr0 = passArrayF32ToWasm0(reference_block, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.ghdspcore_set_reference_block(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} model_json
     */
    set_spectral_model(model_json) {
        const ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ghdspcore_set_spectral_model(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) GhDspCore.prototype[Symbol.dispose] = GhDspCore.prototype.free;

/**
 * @enum {0 | 1 | 2 | 3}
 */
export const PitchDetectorPreset = Object.freeze({
    Baseline: 0, "0": "Baseline",
    Ac14: 1, "1": "Ac14",
    SpectralGameRuntimeUnifiedV3: 2, "2": "SpectralGameRuntimeUnifiedV3",
    Fretnet: 3, "3": "Fretnet",
});

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_6ddd609b62940d55: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_a70fbab9066b301f: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_ab79df5bd7c26067: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_from_slice_ff2c15e8e05ffdfc: function(arg0, arg1) {
            const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_push_e87b0e732085a946: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_set_7eaa4f96924fd6b3: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./gh_dsp_core_bg.js": import0,
    };
}

const GhDspCoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ghdspcore_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

function __decodeUtf8Fallback(bytes) {
    let output = '';
    for (let i = 0; i < bytes.length; i += 1) {
        const byte1 = bytes[i];
        if (byte1 < 0x80) {
            output += String.fromCharCode(byte1);
            continue;
        }
        if (byte1 >= 0xc0 && byte1 < 0xe0 && i + 1 < bytes.length) {
            const byte2 = bytes[i + 1] & 0x3f;
            i += 1;
            output += String.fromCharCode(((byte1 & 0x1f) << 6) | byte2);
            continue;
        }
        if (byte1 >= 0xe0 && byte1 < 0xf0 && i + 2 < bytes.length) {
            const byte2 = bytes[i + 1] & 0x3f;
            const byte3 = bytes[i + 2] & 0x3f;
            i += 2;
            output += String.fromCharCode(((byte1 & 0x0f) << 12) | (byte2 << 6) | byte3);
            continue;
        }
        if (byte1 >= 0xf0 && i + 3 < bytes.length) {
            const byte2 = bytes[i + 1] & 0x3f;
            const byte3 = bytes[i + 2] & 0x3f;
            const byte4 = bytes[i + 3] & 0x3f;
            i += 3;
            const codePoint = ((byte1 & 0x07) << 18) | (byte2 << 12) | (byte3 << 6) | byte4;
            const offset = codePoint - 0x10000;
            output += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
            continue;
        }
        output += '\uFFFD';
    }
    return output;
}

const __TextDecoderImpl = typeof TextDecoder !== 'undefined'
    ? TextDecoder
    : class TextDecoderPolyfill {
        constructor() {}
        decode(input = new Uint8Array()) {
            const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
            return __decodeUtf8Fallback(bytes);
        }
    };

let cachedTextDecoder = new __TextDecoderImpl('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new __TextDecoderImpl('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function __encodeUtf8Fallback(input) {
    const source = String(input ?? '');
    const bytes = [];
    for (let i = 0; i < source.length; i += 1) {
        let codePoint = source.codePointAt(i);
        if (codePoint === undefined) {
            continue;
        }
        if (codePoint > 0xffff) {
            i += 1;
        }
        if (codePoint <= 0x7f) {
            bytes.push(codePoint);
            continue;
        }
        if (codePoint <= 0x7ff) {
            bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
            continue;
        }
        if (codePoint <= 0xffff) {
            bytes.push(
                0xe0 | (codePoint >> 12),
                0x80 | ((codePoint >> 6) & 0x3f),
                0x80 | (codePoint & 0x3f)
            );
            continue;
        }
        bytes.push(
            0xf0 | (codePoint >> 18),
            0x80 | ((codePoint >> 12) & 0x3f),
            0x80 | ((codePoint >> 6) & 0x3f),
            0x80 | (codePoint & 0x3f)
        );
    }
    return new Uint8Array(bytes);
}

const __TextEncoderImpl = typeof TextEncoder !== 'undefined'
    ? TextEncoder
    : class TextEncoderPolyfill {
        encode(input = '') {
            return __encodeUtf8Fallback(input);
        }
    };

const cachedTextEncoder = new __TextEncoderImpl();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('gh_dsp_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
