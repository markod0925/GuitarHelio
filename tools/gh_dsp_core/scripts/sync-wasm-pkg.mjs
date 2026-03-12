import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..', '..', '..');
const sourceDir = path.resolve(projectRoot, 'tools/gh_dsp_core/pkg');
const destinationDirs = [
  path.resolve(projectRoot, 'src/audio/dsp-core'),
  path.resolve(projectRoot, 'public/assets/dsp-core')
];

const filesToCopy = [
  'gh_dsp_core.js',
  'gh_dsp_core.d.ts',
  'gh_dsp_core_bg.wasm',
  'gh_dsp_core_bg.wasm.d.ts'
];

const textDecoderAnchor = "let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });";
const textDecoderResetAnchor = "cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });";
const textDecoderPatch = `
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
        output += '\\uFFFD';
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
`;

async function patchWasmGlue(destinationDir) {
  const jsPath = path.join(destinationDir, 'gh_dsp_core.js');
  let source = await readFile(jsPath, 'utf8');
  if (!source.includes(textDecoderAnchor)) {
    throw new Error(`Unable to patch TextDecoder fallback in ${jsPath}`);
  }
  source = source.replace(textDecoderAnchor, textDecoderPatch.trim());
  source = source.replaceAll(textDecoderResetAnchor, "cachedTextDecoder = new __TextDecoderImpl('utf-8', { ignoreBOM: true, fatal: true });");
  await writeFile(jsPath, source, 'utf8');
}

for (const destinationDir of destinationDirs) {
  await mkdir(destinationDir, { recursive: true });
  for (const fileName of filesToCopy) {
    await copyFile(path.join(sourceDir, fileName), path.join(destinationDir, fileName));
  }
  await patchWasmGlue(destinationDir);
  console.log(`Synced DSP WASM package to ${destinationDir}`);
}
