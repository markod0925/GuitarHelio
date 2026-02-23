export type EmbeddedCoverResult = {
  mimeType: string;
  extension: string;
  data: Uint8Array;
};

const MP3_EXTENSIONS = new Set(['.mp3']);
const OGG_EXTENSIONS = new Set(['.ogg', '.oga', '.opus']);

export function extractEmbeddedCoverFromAudio(
  bytes: Uint8Array,
  fileName: string,
  mimeType = ''
): EmbeddedCoverResult | null {
  if (!bytes || bytes.length === 0) return null;

  const ext = detectAudioExtension(fileName, mimeType);
  if (MP3_EXTENSIONS.has(ext)) {
    return extractMp3Cover(bytes);
  }
  if (OGG_EXTENSIONS.has(ext)) {
    return extractOggCover(bytes);
  }

  return null;
}

function detectAudioExtension(fileName: string, mimeType: string): string {
  const fromName = fileName.trim().toLowerCase().match(/\.([a-z0-9]+)$/i);
  if (fromName) return `.${fromName[1]}`;

  const loweredMime = mimeType.trim().toLowerCase();
  if (loweredMime.includes('audio/mpeg') || loweredMime.includes('audio/mp3')) return '.mp3';
  if (loweredMime.includes('audio/ogg') || loweredMime.includes('audio/x-ogg') || loweredMime.includes('audio/opus')) {
    return '.ogg';
  }

  return '';
}

function extractMp3Cover(bytes: Uint8Array): EmbeddedCoverResult | null {
  if (bytes.length < 10 || readAscii(bytes, 0, 3) !== 'ID3') return null;

  const version = bytes[3];
  const flags = bytes[5];
  const tagSize = readSyncSafeInt(bytes, 6);
  const tagEnd = Math.min(bytes.length, 10 + tagSize);
  let offset = 10;

  if (flags & 0x40) {
    if (version === 3) {
      if (offset + 4 > tagEnd) return null;
      const extSize = readUInt32BE(bytes, offset);
      offset += 4 + extSize;
    } else if (version === 4) {
      const extSize = readSyncSafeInt(bytes, offset);
      offset += extSize;
    }
  }

  while (offset < tagEnd) {
    if (version === 2) {
      if (offset + 6 > tagEnd) break;
      const frameId = readAscii(bytes, offset, 3);
      if (frameId === '\u0000\u0000\u0000') break;

      const frameSize = readUInt24BE(bytes, offset + 3);
      offset += 6;
      if (frameSize <= 0 || offset + frameSize > tagEnd) break;

      if (frameId === 'PIC') {
        const frameData = bytes.subarray(offset, offset + frameSize);
        const parsed = parsePicFrame(frameData);
        if (parsed) return parsed;
      }

      offset += frameSize;
      continue;
    }

    if (offset + 10 > tagEnd) break;
    const frameId = readAscii(bytes, offset, 4);
    if (frameId === '\u0000\u0000\u0000\u0000') break;

    const frameSize = version === 4 ? readSyncSafeInt(bytes, offset + 4) : readUInt32BE(bytes, offset + 4);
    offset += 10;
    if (frameSize <= 0 || offset + frameSize > tagEnd) break;

    if (frameId === 'APIC') {
      const frameData = bytes.subarray(offset, offset + frameSize);
      const parsed = parseApicFrame(frameData);
      if (parsed) return parsed;
    }

    offset += frameSize;
  }

  return null;
}

function parseApicFrame(frameData: Uint8Array): EmbeddedCoverResult | null {
  if (frameData.length < 4) return null;

  const encoding = frameData[0];
  const mimeEnd = indexOfByte(frameData, 0x00, 1);
  if (mimeEnd === -1 || mimeEnd + 1 >= frameData.length) return null;

  const mimeType = readAscii(frameData, 1, mimeEnd - 1).trim().toLowerCase();
  let cursor = mimeEnd + 1;

  if (cursor >= frameData.length) return null;
  cursor += 1;
  cursor = skipTerminatedText(frameData, cursor, encoding);
  if (cursor >= frameData.length) return null;

  return toCoverResult(mimeType, frameData.subarray(cursor));
}

function parsePicFrame(frameData: Uint8Array): EmbeddedCoverResult | null {
  if (frameData.length < 6) return null;

  const encoding = frameData[0];
  const format = readAscii(frameData, 1, 3).toUpperCase();

  let mimeType = 'image/jpeg';
  if (format === 'PNG') mimeType = 'image/png';
  if (format === 'GIF') mimeType = 'image/gif';

  let cursor = 5;
  cursor = skipTerminatedText(frameData, cursor, encoding);
  if (cursor >= frameData.length) return null;

  return toCoverResult(mimeType, frameData.subarray(cursor));
}

function extractOggCover(bytes: Uint8Array): EmbeddedCoverResult | null {
  const packets = extractOggPackets(bytes, 24);

  for (const packet of packets) {
    if (packet.length >= 7 && packet[0] === 0x03 && readAscii(packet, 1, 6) === 'vorbis') {
      const comments = parseVorbisComments(packet, 7);
      const cover = coverFromVorbisComments(comments);
      if (cover) return cover;
    }

    if (packet.length >= 8 && readAscii(packet, 0, 8) === 'OpusTags') {
      const comments = parseVorbisComments(packet, 8);
      const cover = coverFromVorbisComments(comments);
      if (cover) return cover;
    }
  }

  return null;
}

function extractOggPackets(bytes: Uint8Array, maxPackets: number): Uint8Array[] {
  const packets: Uint8Array[] = [];
  const pending: Uint8Array[] = [];
  let offset = 0;

  while (offset + 27 <= bytes.length && packets.length < maxPackets) {
    const pageStart = indexOfAscii(bytes, 'OggS', offset);
    if (pageStart === -1 || pageStart + 27 > bytes.length) break;

    const segmentCount = bytes[pageStart + 26];
    const segmentTableStart = pageStart + 27;
    const segmentTableEnd = segmentTableStart + segmentCount;
    if (segmentTableEnd > bytes.length) break;

    let payloadSize = 0;
    for (let i = 0; i < segmentCount; i += 1) {
      payloadSize += bytes[segmentTableStart + i];
    }

    const payloadStart = segmentTableEnd;
    const payloadEnd = payloadStart + payloadSize;
    if (payloadEnd > bytes.length) break;

    let cursor = payloadStart;
    for (let i = 0; i < segmentCount; i += 1) {
      const lacingValue = bytes[segmentTableStart + i];
      const nextCursor = cursor + lacingValue;
      if (nextCursor > payloadEnd) return packets;

      pending.push(bytes.subarray(cursor, nextCursor));
      cursor = nextCursor;

      if (lacingValue < 255) {
        packets.push(concatUint8Arrays(pending));
        pending.length = 0;
        if (packets.length >= maxPackets) return packets;
      }
    }

    offset = payloadEnd;
  }

  return packets;
}

function parseVorbisComments(packet: Uint8Array, offset: number): string[] {
  if (offset + 8 > packet.length) return [];

  let cursor = offset;
  const vendorLength = readUInt32LE(packet, cursor);
  cursor += 4;
  if (cursor + vendorLength > packet.length) return [];

  cursor += vendorLength;
  if (cursor + 4 > packet.length) return [];

  const commentCount = readUInt32LE(packet, cursor);
  cursor += 4;

  const comments: string[] = [];
  for (let i = 0; i < commentCount; i += 1) {
    if (cursor + 4 > packet.length) break;
    const length = readUInt32LE(packet, cursor);
    cursor += 4;
    if (length < 0 || cursor + length > packet.length) break;

    comments.push(decodeUtf8(packet.subarray(cursor, cursor + length)));
    cursor += length;
  }

  return comments;
}

function coverFromVorbisComments(comments: string[]): EmbeddedCoverResult | null {
  const tags = new Map<string, string>();

  for (const entry of comments) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;

    const key = entry.slice(0, separator).trim().toUpperCase();
    const value = entry.slice(separator + 1).trim();
    if (!key || !value || tags.has(key)) continue;
    tags.set(key, value);
  }

  const metadataPicture = tags.get('METADATA_BLOCK_PICTURE');
  if (metadataPicture) {
    const decoded = decodeBase64(metadataPicture);
    if (decoded) {
      const cover = parseFlacPictureBlock(decoded);
      if (cover) return cover;
    }
  }

  const coverArt = tags.get('COVERART');
  if (coverArt) {
    const decoded = decodeBase64(coverArt);
    if (decoded) {
      const mimeType = tags.get('COVERARTMIME') || 'image/jpeg';
      const cover = toCoverResult(mimeType, decoded);
      if (cover) return cover;
    }
  }

  return null;
}

function parseFlacPictureBlock(payload: Uint8Array): EmbeddedCoverResult | null {
  if (payload.length < 32) return null;

  let cursor = 0;
  cursor += 4;

  if (cursor + 4 > payload.length) return null;
  const mimeLength = readUInt32BE(payload, cursor);
  cursor += 4;
  if (cursor + mimeLength > payload.length) return null;

  const mimeType = decodeUtf8(payload.subarray(cursor, cursor + mimeLength)).trim().toLowerCase();
  cursor += mimeLength;

  if (cursor + 4 > payload.length) return null;
  const descriptionLength = readUInt32BE(payload, cursor);
  cursor += 4 + descriptionLength;
  if (cursor + 16 > payload.length) return null;
  cursor += 16;

  if (cursor + 4 > payload.length) return null;
  const imageLength = readUInt32BE(payload, cursor);
  cursor += 4;
  if (cursor + imageLength > payload.length) return null;

  return toCoverResult(mimeType, payload.subarray(cursor, cursor + imageLength));
}

function toCoverResult(mimeType: string, payload: Uint8Array): EmbeddedCoverResult | null {
  if (!payload || payload.length === 0) return null;

  const normalizedMime = mimeType.trim().toLowerCase();
  const finalMime = normalizedMime.startsWith('image/')
    ? normalizedMime
    : guessImageMimeFromData(payload, 'image/jpeg');

  return {
    mimeType: finalMime,
    extension: extensionFromMimeType(finalMime),
    data: new Uint8Array(payload)
  };
}

function guessImageMimeFromData(data: Uint8Array, fallbackMime: string): string {
  if (data.length < 4) return fallbackMime;

  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif';
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp';
  }

  return fallbackMime;
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/bmp') return '.bmp';
  if (normalized === 'image/tiff') return '.tiff';
  return '.jpg';
}

function skipTerminatedText(bytes: Uint8Array, start: number, encoding: number): number {
  if (start >= bytes.length) return bytes.length;

  if (encoding === 1 || encoding === 2) {
    for (let i = start; i + 1 < bytes.length; i += 1) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return i + 2;
    }
    return bytes.length;
  }

  const end = indexOfByte(bytes, 0x00, start);
  return end === -1 ? bytes.length : end + 1;
}

function concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);

  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(value);
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const compact = value.replace(/\s+/g, '');
    const raw = atob(compact);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      bytes[i] = raw.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function indexOfAscii(bytes: Uint8Array, value: string, start: number): number {
  const target = new TextEncoder().encode(value);
  const max = bytes.length - target.length;

  for (let i = Math.max(0, start); i <= max; i += 1) {
    let match = true;
    for (let j = 0; j < target.length; j += 1) {
      if (bytes[i + j] !== target[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }

  return -1;
}

function indexOfByte(bytes: Uint8Array, needle: number, start: number): number {
  for (let i = Math.max(0, start); i < bytes.length; i += 1) {
    if (bytes[i] === needle) return i;
  }
  return -1;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  const end = Math.min(bytes.length, offset + length);
  let out = '';
  for (let i = offset; i < end; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function readSyncSafeInt(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function readUInt24BE(bytes: Uint8Array, offset: number): number {
  if (offset + 3 > bytes.length) return 0;
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  return (bytes[offset] * 0x1000000) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] * 0x1000000);
}
