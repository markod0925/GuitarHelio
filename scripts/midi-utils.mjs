function readUInt32BE(bytes, offset) {
  return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
}

function readUInt16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function encodeVarLen(value) {
  let buffer = value & 0x7f;
  const out = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    out.push(buffer & 0xff);
    if (buffer & 0x80) {
      buffer >>= 8;
    } else {
      break;
    }
  }
  return out;
}

function readVarLen(bytes, offset) {
  let value = 0;
  let i = offset;
  while (i < bytes.length) {
    const current = bytes[i];
    value = (value << 7) + (current & 0x7f);
    i += 1;
    if ((current & 0x80) === 0) {
      break;
    }
  }
  return { value, nextOffset: i };
}

function ticksToSeconds(ticks, tempoEvents, ppq) {
  let seconds = 0;
  let lastTick = 0;
  let lastTempo = 500000;

  for (const evt of tempoEvents) {
    if (evt.tick >= ticks) {
      break;
    }
    seconds += ((evt.tick - lastTick) * lastTempo) / 1_000_000 / ppq;
    lastTick = evt.tick;
    lastTempo = evt.microsecondsPerQuarter;
  }

  seconds += ((ticks - lastTick) * lastTempo) / 1_000_000 / ppq;
  return seconds;
}

export function parseMidi(buffer) {
  const bytes = new Uint8Array(buffer);
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'MThd') {
    throw new Error('Invalid MIDI file: missing MThd header');
  }

  const headerLength = readUInt32BE(bytes, 4);
  const formatType = readUInt16BE(bytes, 8);
  const trackCount = readUInt16BE(bytes, 10);
  const division = readUInt16BE(bytes, 12);

  if ((division & 0x8000) !== 0) {
    throw new Error('SMPTE time division is not supported');
  }

  const ppq = division;
  let offset = 8 + headerLength;

  const tempoEvents = [{ tick: 0, microsecondsPerQuarter: 500000 }];
  const notes = [];
  const activeNotes = new Map();
  let maxTickSeen = 0;

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    if (String.fromCharCode(...bytes.slice(offset, offset + 4)) !== 'MTrk') {
      throw new Error(`Invalid MIDI file: missing MTrk chunk for track ${trackIndex}`);
    }

    const trackLength = readUInt32BE(bytes, offset + 4);
    const trackEnd = offset + 8 + trackLength;
    let cursor = offset + 8;
    let tick = 0;
    let runningStatus = null;

    while (cursor < trackEnd) {
      const delta = readVarLen(bytes, cursor);
      tick += delta.value;
      if (tick > maxTickSeen) maxTickSeen = tick;
      cursor = delta.nextOffset;

      let status = bytes[cursor];
      if (status < 0x80) {
        if (runningStatus === null) {
          throw new Error('Running status encountered without previous status byte');
        }
        status = runningStatus;
      } else {
        cursor += 1;
        if (status < 0xf0) {
          runningStatus = status;
        }
      }

      if (status === 0xff) {
        const metaType = bytes[cursor];
        cursor += 1;
        const metaLenData = readVarLen(bytes, cursor);
        const metaLength = metaLenData.value;
        cursor = metaLenData.nextOffset;
        if (metaType === 0x51 && metaLength === 3) {
          const mpq = (bytes[cursor] << 16) | (bytes[cursor + 1] << 8) | bytes[cursor + 2];
          tempoEvents.push({ tick, microsecondsPerQuarter: mpq });
        }
        cursor += metaLength;
      } else if (status === 0xf0 || status === 0xf7) {
        const sysexLenData = readVarLen(bytes, cursor);
        cursor = sysexLenData.nextOffset + sysexLenData.value;
      } else {
        const type = status & 0xf0;
        const channel = status & 0x0f;

        const data1 = bytes[cursor];
        cursor += 1;
        const requiresTwoDataBytes = type !== 0xc0 && type !== 0xd0;
        const data2 = requiresTwoDataBytes ? bytes[cursor++] : 0;

        if (type === 0x90 && data2 > 0) {
          activeNotes.set(`${trackIndex}:${channel}:${data1}`, { tickOn: tick, velocity: data2 / 127 });
        } else if (type === 0x80 || (type === 0x90 && data2 === 0)) {
          const key = `${trackIndex}:${channel}:${data1}`;
          const active = activeNotes.get(key);
          if (active) {
            notes.push({
              trackIndex,
              channel,
              midi: data1,
              tickOn: active.tickOn,
              tickOff: tick,
              velocity: active.velocity
            });
            activeNotes.delete(key);
          }
        }
      }
    }

    offset = trackEnd;
  }

  tempoEvents.sort((a, b) => a.tick - b.tick);

  const notesWithTime = notes.map((note) => {
    const timeOn = ticksToSeconds(note.tickOn, tempoEvents, ppq);
    const timeOff = ticksToSeconds(note.tickOff, tempoEvents, ppq);
    return {
      ...note,
      timeOn,
      duration: Math.max(0, timeOff - timeOn)
    };
  });

  const noteDurationSeconds = notesWithTime.reduce((max, note) => Math.max(max, note.timeOn + note.duration), 0);
  const timelineDurationSeconds = ticksToSeconds(maxTickSeen, tempoEvents, ppq);
  const durationSeconds = Math.max(noteDurationSeconds, timelineDurationSeconds);

  return {
    formatType,
    trackCount,
    ppq,
    tempoEvents,
    notes: notesWithTime,
    durationSeconds
  };
}

function buildTrackChunk(events) {
  const body = [];
  for (const event of events) {
    body.push(...encodeVarLen(event.delta));
    body.push(...event.bytes);
  }
  body.push(0x00, 0xff, 0x2f, 0x00);

  const chunk = [
    0x4d, 0x54, 0x72, 0x6b,
    (body.length >>> 24) & 0xff,
    (body.length >>> 16) & 0xff,
    (body.length >>> 8) & 0xff,
    body.length & 0xff,
    ...body
  ];

  return chunk;
}

export function createSampleMidiBytes() {
  const ppq = 480;
  const melody = [60, 62, 64, 65, 67, 69, 71, 72];

  const flattened = [];
  let previousTick = 0;
  const absoluteEvents = [];

  absoluteEvents.push({ tick: 0, bytes: [0xff, 0x51, 0x03, 0x09, 0x27, 0xc0] });
  melody.forEach((midi, index) => {
    const tick = index * ppq;
    absoluteEvents.push({ tick, bytes: [0x90, midi, 100] });
    absoluteEvents.push({ tick: tick + ppq, bytes: [0x80, midi, 0] });
  });

  absoluteEvents.sort((a, b) => a.tick - b.tick || a.bytes[0] - b.bytes[0]);
  for (const evt of absoluteEvents) {
    flattened.push({ delta: evt.tick - previousTick, bytes: evt.bytes });
    previousTick = evt.tick;
  }

  const header = [
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    (ppq >>> 8) & 0xff,
    ppq & 0xff
  ];

  const trackChunk = buildTrackChunk(flattened);
  return Uint8Array.from([...header, ...trackChunk]);
}
