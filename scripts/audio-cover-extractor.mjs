import path from 'node:path';

const MP3_EXTENSIONS = new Set(['.mp3']);
const OGG_EXTENSIONS = new Set(['.ogg', '.oga', '.opus']);

function normalizeText(value) {
  return String(value || '').trim();
}

function getExtension(fileName = '', mimeType = '') {
  const fromName = path.extname(normalizeText(fileName)).toLowerCase();
  if (fromName) return fromName;

  const loweredMime = normalizeText(mimeType).toLowerCase();
  if (loweredMime.includes('audio/mpeg') || loweredMime.includes('audio/mp3')) return '.mp3';
  if (loweredMime.includes('audio/ogg') || loweredMime.includes('audio/x-ogg') || loweredMime.includes('audio/opus')) {
    return '.ogg';
  }

  return '';
}

function readSyncSafeInt(buffer, offset) {
  if (offset + 4 > buffer.length) return 0;
  return (
    ((buffer[offset] & 0x7f) << 21) |
    ((buffer[offset + 1] & 0x7f) << 14) |
    ((buffer[offset + 2] & 0x7f) << 7) |
    (buffer[offset + 3] & 0x7f)
  );
}

function readUInt24BE(buffer, offset) {
  if (offset + 3 > buffer.length) return 0;
  return (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
}

function skipTerminatedText(buffer, start, encoding) {
  if (start >= buffer.length) return buffer.length;

  if (encoding === 1 || encoding === 2) {
    for (let i = start; i + 1 < buffer.length; i += 1) {
      if (buffer[i] === 0 && buffer[i + 1] === 0) {
        return i + 2;
      }
    }
    return buffer.length;
  }

  const end = buffer.indexOf(0x00, start);
  return end === -1 ? buffer.length : end + 1;
}

function guessImageMimeFromData(data, fallbackMime = 'image/jpeg') {
  if (!data || data.length < 4) return fallbackMime;
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

function extensionFromMimeType(mimeType) {
  const normalized = normalizeText(mimeType).toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/bmp') return '.bmp';
  if (normalized === 'image/tiff') return '.tiff';
  return '.jpg';
}

function toCoverResult(mimeType, payload) {
  const safeBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (!safeBuffer || safeBuffer.length === 0) return null;

  const normalizedMime = normalizeText(mimeType).toLowerCase();
  const finalMime = normalizedMime.startsWith('image/')
    ? normalizedMime
    : guessImageMimeFromData(safeBuffer, 'image/jpeg');

  return {
    mimeType: finalMime,
    extension: extensionFromMimeType(finalMime),
    data: safeBuffer
  };
}

function parseApicFrame(frameData) {
  if (!frameData || frameData.length < 4) return null;

  const encoding = frameData[0];
  const mimeEnd = frameData.indexOf(0x00, 1);
  if (mimeEnd === -1 || mimeEnd + 1 >= frameData.length) return null;

  const mimeType = frameData.toString('latin1', 1, mimeEnd).trim().toLowerCase();
  let cursor = mimeEnd + 1;

  if (cursor >= frameData.length) return null;
  cursor += 1; // Picture type byte.
  cursor = skipTerminatedText(frameData, cursor, encoding);

  if (cursor >= frameData.length) return null;
  return toCoverResult(mimeType, frameData.subarray(cursor));
}

function parsePicFrame(frameData) {
  if (!frameData || frameData.length < 6) return null;

  const encoding = frameData[0];
  const format = frameData.toString('latin1', 1, 4).toUpperCase();

  let mimeType = 'image/jpeg';
  if (format === 'PNG') mimeType = 'image/png';
  if (format === 'GIF') mimeType = 'image/gif';

  let cursor = 5; // 1 byte encoding + 3 bytes format + 1 byte picture type.
  cursor = skipTerminatedText(frameData, cursor, encoding);

  if (cursor >= frameData.length) return null;
  return toCoverResult(mimeType, frameData.subarray(cursor));
}

function extractMp3Cover(buffer) {
  if (!buffer || buffer.length < 10) return null;
  if (buffer.toString('latin1', 0, 3) !== 'ID3') return null;

  const version = buffer[3];
  const flags = buffer[5];
  const tagSize = readSyncSafeInt(buffer, 6);
  const tagEnd = Math.min(buffer.length, 10 + tagSize);
  let offset = 10;

  if (flags & 0x40) {
    if (version === 3) {
      if (offset + 4 > tagEnd) return null;
      const extSize = buffer.readUInt32BE(offset);
      offset += 4 + extSize;
    } else if (version === 4) {
      const extSize = readSyncSafeInt(buffer, offset);
      offset += extSize;
    }
  }

  while (offset < tagEnd) {
    if (version === 2) {
      if (offset + 6 > tagEnd) break;
      const frameId = buffer.toString('latin1', offset, offset + 3);
      if (frameId === '\u0000\u0000\u0000') break;
      const frameSize = readUInt24BE(buffer, offset + 3);
      offset += 6;
      if (frameSize <= 0 || offset + frameSize > tagEnd) break;

      if (frameId === 'PIC') {
        const cover = parsePicFrame(buffer.subarray(offset, offset + frameSize));
        if (cover) return cover;
      }

      offset += frameSize;
      continue;
    }

    if (offset + 10 > tagEnd) break;
    const frameId = buffer.toString('latin1', offset, offset + 4);
    if (frameId === '\u0000\u0000\u0000\u0000') break;

    const frameSize = version === 4 ? readSyncSafeInt(buffer, offset + 4) : buffer.readUInt32BE(offset + 4);
    offset += 10;

    if (frameSize <= 0 || offset + frameSize > tagEnd) {
      break;
    }

    if (frameId === 'APIC') {
      const cover = parseApicFrame(buffer.subarray(offset, offset + frameSize));
      if (cover) return cover;
    }

    offset += frameSize;
  }

  return null;
}

function extractOggPackets(buffer, maxPackets = 16) {
  const packets = [];
  let offset = 0;
  let pending = [];

  while (offset + 27 <= buffer.length && packets.length < maxPackets) {
    const pageStart = buffer.indexOf('OggS', offset, 'latin1');
    if (pageStart === -1 || pageStart + 27 > buffer.length) break;

    const segmentCount = buffer[pageStart + 26];
    const segmentTableStart = pageStart + 27;
    const segmentTableEnd = segmentTableStart + segmentCount;
    if (segmentTableEnd > buffer.length) break;

    let payloadSize = 0;
    for (let i = 0; i < segmentCount; i += 1) {
      payloadSize += buffer[segmentTableStart + i];
    }

    const payloadStart = segmentTableEnd;
    const payloadEnd = payloadStart + payloadSize;
    if (payloadEnd > buffer.length) break;

    let cursor = payloadStart;
    for (let i = 0; i < segmentCount; i += 1) {
      const lacingValue = buffer[segmentTableStart + i];
      const nextCursor = cursor + lacingValue;
      if (nextCursor > payloadEnd) return packets;

      pending.push(buffer.subarray(cursor, nextCursor));
      cursor = nextCursor;

      if (lacingValue < 255) {
        packets.push(Buffer.concat(pending));
        pending = [];
        if (packets.length >= maxPackets) return packets;
      }
    }

    offset = payloadEnd;
  }

  return packets;
}

function parseVorbisComments(packet, offset) {
  if (offset + 8 > packet.length) return [];

  let cursor = offset;
  const vendorLength = packet.readUInt32LE(cursor);
  cursor += 4;
  if (cursor + vendorLength > packet.length) return [];
  cursor += vendorLength;

  if (cursor + 4 > packet.length) return [];
  const commentCount = packet.readUInt32LE(cursor);
  cursor += 4;

  const comments = [];
  for (let i = 0; i < commentCount; i += 1) {
    if (cursor + 4 > packet.length) break;
    const length = packet.readUInt32LE(cursor);
    cursor += 4;
    if (length < 0 || cursor + length > packet.length) break;
    comments.push(packet.toString('utf8', cursor, cursor + length));
    cursor += length;
  }

  return comments;
}

function parseFlacPictureBlock(payload) {
  if (!payload || payload.length < 32) return null;

  let cursor = 0;
  if (cursor + 4 > payload.length) return null;
  cursor += 4; // picture type

  if (cursor + 4 > payload.length) return null;
  const mimeLength = payload.readUInt32BE(cursor);
  cursor += 4;
  if (cursor + mimeLength > payload.length) return null;
  const mimeType = payload.toString('utf8', cursor, cursor + mimeLength).trim().toLowerCase();
  cursor += mimeLength;

  if (cursor + 4 > payload.length) return null;
  const descriptionLength = payload.readUInt32BE(cursor);
  cursor += 4 + descriptionLength;
  if (cursor + 16 > payload.length) return null;

  cursor += 16; // width, height, depth, colors

  if (cursor + 4 > payload.length) return null;
  const imageLength = payload.readUInt32BE(cursor);
  cursor += 4;
  if (cursor + imageLength > payload.length) return null;

  const imageData = payload.subarray(cursor, cursor + imageLength);
  return toCoverResult(mimeType, imageData);
}

function coverFromVorbisComments(comments) {
  const tags = new Map();
  comments.forEach((entry) => {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) return;

    const key = entry.slice(0, separatorIndex).trim().toUpperCase();
    const value = entry.slice(separatorIndex + 1).trim();
    if (!key || !value || tags.has(key)) return;
    tags.set(key, value);
  });

  const metadataPicture = tags.get('METADATA_BLOCK_PICTURE');
  if (metadataPicture) {
    try {
      const payload = Buffer.from(metadataPicture.replace(/\s+/g, ''), 'base64');
      const cover = parseFlacPictureBlock(payload);
      if (cover) return cover;
    } catch {
      // Ignore malformed base64 comments.
    }
  }

  const coverArt = tags.get('COVERART');
  if (coverArt) {
    try {
      const payload = Buffer.from(coverArt.replace(/\s+/g, ''), 'base64');
      const mimeType = tags.get('COVERARTMIME') || 'image/jpeg';
      const cover = toCoverResult(mimeType, payload);
      if (cover) return cover;
    } catch {
      // Ignore malformed base64 comments.
    }
  }

  return null;
}

function extractOggCover(buffer) {
  const packets = extractOggPackets(buffer);

  for (const packet of packets) {
    if (packet.length >= 7 && packet[0] === 0x03 && packet.toString('latin1', 1, 7) === 'vorbis') {
      const comments = parseVorbisComments(packet, 7);
      const cover = coverFromVorbisComments(comments);
      if (cover) return cover;
    }

    if (packet.length >= 8 && packet.toString('latin1', 0, 8) === 'OpusTags') {
      const comments = parseVorbisComments(packet, 8);
      const cover = coverFromVorbisComments(comments);
      if (cover) return cover;
    }
  }

  return null;
}

export function extractEmbeddedCover({ buffer, fileName = '', mimeType = '' }) {
  const safeBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (safeBuffer.length === 0) return null;

  const ext = getExtension(fileName, mimeType);
  if (MP3_EXTENSIONS.has(ext)) return extractMp3Cover(safeBuffer);
  if (OGG_EXTENSIONS.has(ext)) return extractOggCover(safeBuffer);

  return null;
}
