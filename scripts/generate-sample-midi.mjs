import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSampleMidiBytes } from './midi-utils.mjs';

const outputArg = process.argv[2] ?? 'public/songs/example/song.mid';
const outputPath = path.resolve(process.cwd(), outputArg);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, Buffer.from(createSampleMidiBytes()));

console.log(`Sample MIDI written to ${outputPath}`);
