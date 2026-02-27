const TEMPO_BPM_MIN = 20;
const TEMPO_BPM_MAX = 300;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(value, fallback = 0) {
  const safe = Number(value);
  return Number.isFinite(safe) ? safe : fallback;
}

function parseTempoPoint(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const rawTime = Number(entry.timeSeconds ?? entry.time ?? entry.seconds ?? entry.t);
  const rawBpm = Number(entry.bpm ?? entry.tempo ?? entry.value);
  if (!Number.isFinite(rawTime) || rawTime < 0) return null;
  if (!Number.isFinite(rawBpm) || rawBpm <= 0) return null;
  return {
    timeSeconds: rawTime,
    bpm: clamp(rawBpm, TEMPO_BPM_MIN, TEMPO_BPM_MAX)
  };
}

function normalizeTempoMap(rawTempoMap, fallbackTempoBpm) {
  const safeFallbackBpm = clamp(toFiniteNumber(fallbackTempoBpm, 120), TEMPO_BPM_MIN, TEMPO_BPM_MAX);
  const parsed = Array.isArray(rawTempoMap) ? rawTempoMap.map((entry) => parseTempoPoint(entry)).filter(Boolean) : [];

  if (parsed.length === 0) {
    return [{ timeSeconds: 0, bpm: safeFallbackBpm }];
  }

  parsed.sort((left, right) => left.timeSeconds - right.timeSeconds);

  const deduped = [];
  for (const point of parsed) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(point.timeSeconds - last.timeSeconds) < 1e-6) {
      deduped[deduped.length - 1] = point;
      continue;
    }
    if (!last || Math.abs(point.bpm - last.bpm) >= 0.05 || point.timeSeconds - last.timeSeconds >= 0.2) {
      deduped.push(point);
    }
  }

  if (deduped.length === 0 || deduped[0].timeSeconds > 1e-6) {
    const firstBpm = deduped.length > 0 ? deduped[0].bpm : safeFallbackBpm;
    deduped.unshift({ timeSeconds: 0, bpm: firstBpm });
  } else {
    deduped[0].timeSeconds = 0;
  }

  return deduped;
}

function appendEndPoint(tempoMap, audioDurationSeconds) {
  if (!Number.isFinite(audioDurationSeconds) || audioDurationSeconds < 0) return tempoMap;
  if (tempoMap.length === 0) return tempoMap;

  const safeDuration = Math.max(0, audioDurationSeconds);
  const out = [...tempoMap];
  const last = out[out.length - 1];
  if (safeDuration > last.timeSeconds + 1e-6) {
    out.push({
      timeSeconds: safeDuration,
      bpm: last.bpm
    });
  } else if (Math.abs(safeDuration - last.timeSeconds) <= 1e-6) {
    out[out.length - 1] = {
      timeSeconds: safeDuration,
      bpm: last.bpm
    };
  }
  return out;
}

function toTempoTickEvents(tempoMap, ppq) {
  const safePpq = Math.max(1, Math.round(toFiniteNumber(ppq, 480)));
  if (!Array.isArray(tempoMap) || tempoMap.length === 0) return [{ ticks: 0, bpm: 120 }];

  const events = [{ ticks: 0, bpm: tempoMap[0].bpm }];
  let elapsedTicks = 0;
  let lastTime = tempoMap[0].timeSeconds;
  let lastBpm = tempoMap[0].bpm;

  for (let index = 1; index < tempoMap.length; index += 1) {
    const point = tempoMap[index];
    const deltaSeconds = Math.max(0, point.timeSeconds - lastTime);
    elapsedTicks += deltaSeconds * ((safePpq * lastBpm) / 60);
    const roundedTick = Math.max(events[events.length - 1].ticks, Math.round(elapsedTicks));

    if (roundedTick === events[events.length - 1].ticks) {
      events[events.length - 1] = { ticks: roundedTick, bpm: point.bpm };
    } else {
      events.push({ ticks: roundedTick, bpm: point.bpm });
    }

    lastTime = point.timeSeconds;
    lastBpm = point.bpm;
  }

  return events;
}

export function applyTempoMetadataToMidi(midi, options = {}) {
  if (!midi || !midi.header) return;

  const fallbackTempoBpm = clamp(toFiniteNumber(options.tempoBpm, 120), TEMPO_BPM_MIN, TEMPO_BPM_MAX);
  const normalizedTempoMap = normalizeTempoMap(options.tempoMap, fallbackTempoBpm);
  const tempoMapWithEndPoint = appendEndPoint(normalizedTempoMap, Number(options.audioDurationSeconds));
  const tempoEvents = toTempoTickEvents(tempoMapWithEndPoint, midi.header.ppq);
  midi.header.tempos = tempoEvents;
  midi.header.update?.();
}

