/* tslint:disable */
/* eslint-disable */

export enum DspMode {
    Speaker = 0,
    Headphones = 1,
}

export class GhDspCore {
    free(): void;
    [Symbol.dispose](): void;
    constructor();
    prepare(sample_rate: number, block_size: number, mode: DspMode): void;
    process_block(mic_block: Float32Array): any;
    reset(): void;
    set_reference_block(reference_block: Float32Array): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_ghdspcore_free: (a: number, b: number) => void;
    readonly ghdspcore_new: () => number;
    readonly ghdspcore_prepare: (a: number, b: number, c: number, d: number) => void;
    readonly ghdspcore_process_block: (a: number, b: number, c: number) => any;
    readonly ghdspcore_reset: (a: number) => void;
    readonly ghdspcore_set_reference_block: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
