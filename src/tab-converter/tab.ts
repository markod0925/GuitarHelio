import { getDifficultyPreset } from "./difficulty-presets";
import { computeIsolatedPathDifficulty } from "./difficulty";
import { Fretboard } from "./fretboard";
import { buildTransitionMatrix, difficultiesToProbabilities, viterbi } from "./graph-utils";
import { fillMeasureStr, getEventsBetween, getNonDrum, measureLengthTicks } from "./midi-utils";
import { Measure, Note, Tuning } from "./theory";
import type {
  DifficultyLevel,
  FallbackStrategy,
  FretboardConstraints,
  MidiNoteEvent,
  MidiSong,
  SoftModeOptions,
  TabEvent,
  TabEventProcessingDiagnostics,
  TabJson,
  TabWeights,
  TimeSignatureEvent,
  TimelineEventData,
} from "./types";

interface BuildHmmResult {
  observations: number[];
  stateFingerings: Note[][];
  eventSequenceMappings: EventSequenceMapping[];
  emissionMatrix: number[][];
  initialProbabilities: number[] | null;
}

interface RankedEventNote {
  pitch: number;
  velocity: number;
  startTicks: number;
  durationTicks: number;
  importance: number;
}

interface EventCandidate {
  subsetId: string;
  originalPitches: number[];
  mergedPitches: number[];
  keptPitches: number[];
  droppedPitches: number[];
  droppedNotes: number;
  droppedWeight: number;
  dropCost: number;
  emission: number;
  fingerings: Note[][];
}

interface EventStateMetadata {
  emission: number;
  diagnostics: TabEventProcessingDiagnostics;
}

interface EventSequenceMapping {
  event: TabEvent;
  metadataByState: Map<number, EventStateMetadata>;
}

const EPSILON = 1e-12;

export interface TabOptions {
  difficulty?: DifficultyLevel;
  weights?: TabWeights;
  fretboardConstraints?: Partial<FretboardConstraints>;
  allowNoteDrop?: boolean;
  velocityThreshold?: number;
  minDurationTicks?: number;
  onsetMergeWindowTicks?: number;
  maxNotesPerEvent?: number;
  maxSubsetCandidates?: number;
  alpha?: number;
  beta?: number;
  dropPenalty?: number;
  fallbackStrategy?: FallbackStrategy;
  includeEventDiagnostics?: boolean;
  outputDir?: string;
}

export class Tab {
  readonly name: string;
  readonly tuning: Tuning;
  readonly midi: MidiSong;
  readonly difficulty: DifficultyLevel;
  readonly weights: TabWeights;
  readonly softOptions: SoftModeOptions;
  readonly outputDir?: string;
  readonly timeSignatures: TimeSignatureEvent[];
  readonly nstrings: number;
  readonly fretboard: Fretboard;
  readonly timeline: Map<number, TimelineEventData>;
  readonly measures: Measure[];
  readonly tab: TabJson;

  constructor(name: string, tuning: Tuning, midi: MidiSong, options: TabOptions = {}) {
    const preset = getDifficultyPreset(options.difficulty ?? "medium");

    this.name = name;
    this.tuning = tuning;
    this.midi = midi;
    this.difficulty = preset.level;
    this.weights = options.weights ?? preset.weights;
    this.outputDir = options.outputDir;

    const presetSoft = preset.soft;
    this.softOptions = {
      allowNoteDrop: options.allowNoteDrop ?? presetSoft.allowNoteDrop,
      velocityThreshold: options.velocityThreshold ?? presetSoft.velocityThreshold,
      minDurationTicks: options.minDurationTicks ?? presetSoft.minDurationTicks,
      onsetMergeWindowTicks: options.onsetMergeWindowTicks ?? presetSoft.onsetMergeWindowTicks,
      maxNotesPerEvent: Math.min(
        options.maxNotesPerEvent ?? presetSoft.maxNotesPerEvent,
        tuning.nstrings,
      ),
      maxSubsetCandidates: options.maxSubsetCandidates ?? presetSoft.maxSubsetCandidates,
      alpha: options.alpha ?? presetSoft.alpha,
      beta: options.beta ?? presetSoft.beta,
      dropPenalty: options.dropPenalty ?? presetSoft.dropPenalty,
      fallbackStrategy: options.fallbackStrategy ?? presetSoft.fallbackStrategy,
      includeEventDiagnostics: options.includeEventDiagnostics ?? presetSoft.includeEventDiagnostics,
    };

    this.timeSignatures =
      midi.timeSignatures.length > 0
        ? midi.timeSignatures
        : [{ numerator: 4, denominator: 4, ticks: 0, time: 0 }];
    this.nstrings = tuning.nstrings;
    this.fretboard = new Fretboard(tuning, {
      ...preset.fretboard,
      ...(options.fretboardConstraints ?? {}),
    });
    this.timeline = this.buildTimeline();
    this.measures = [];

    this.populate();
    this.tab = this.genTab();
  }

  private populate(): void {
    for (let i = 0; i < this.timeSignatures.length; i++) {
      const timeSignature = this.timeSignatures[i];
      const measureLengthInTicks = measureLengthTicks(this.midi, timeSignature);
      const timeSigStart = timeSignature.ticks;
      const timeSigEnd =
        i < this.timeSignatures.length - 1 ? this.timeSignatures[i + 1].ticks : this.midi.endTicks;

      let imeasure = 0;
      for (
        let measureStart = timeSigStart;
        measureStart < timeSigEnd;
        measureStart += measureLengthInTicks
      ) {
        const measureEnd = Math.min(measureStart + measureLengthInTicks, timeSigEnd);
        this.measures.push(
          new Measure(
            imeasure,
            timeSignature,
            measureStart,
            measureEnd,
            getEventsBetween(this.timeline, measureStart, measureEnd),
          ),
        );
        imeasure += 1;
      }
    }
  }

  private buildTimeline(): Map<number, TimelineEventData> {
    const timeline = new Map<number, TimelineEventData>();
    const nonDrumInstruments = getNonDrum(this.midi.tracks);
    const allNotes = nonDrumInstruments
      .flatMap((instrument) => instrument.notes)
      .sort((a, b) => a.startTicks - b.startTicks);

    const noteClusters = this.clusterNotesByOnset(allNotes);
    for (const cluster of noteClusters) {
      const aggregated = this.aggregateClusterNotes(cluster);
      const filtered = aggregated.filter((note) => {
        const durationTicks = note.endTicks - note.startTicks;
        const passesBaseFilters =
          note.velocity >= this.softOptions.velocityThreshold &&
          durationTicks >= this.softOptions.minDurationTicks;

        if (!passesBaseFilters) {
          return false;
        }

        // When explicit string/fret filters are configured, drop notes that cannot be mapped.
        if (this.fretboard.hasExplicitPositionFilter) {
          return this.fretboard.hasPlayablePositionForPitch(note.pitch);
        }

        return true;
      });

      if (filtered.length === 0) {
        continue;
      }

      const eventTick = Math.min(...filtered.map((note) => note.startTicks));
      const event = timeline.get(eventTick) ?? {};
      const eventNotes = event.notes ?? [];
      eventNotes.push(...filtered);
      event.notes = eventNotes.sort((a, b) => a.pitch - b.pitch || a.startTicks - b.startTicks);
      timeline.set(eventTick, event);
    }

    for (const timeSignature of this.timeSignatures) {
      const tick = timeSignature.ticks;
      const event = timeline.get(tick) ?? {};
      event.time_signature = timeSignature;
      timeline.set(tick, event);
    }

    return new Map([...timeline.entries()].sort(([a], [b]) => a - b));
  }

  private genTab(): TabJson {
    const tab: TabJson = {
      tuning: this.tuning.strings.map((string) => string.pitch),
      measures: [],
    };

    const {
      observations,
      stateFingerings,
      eventSequenceMappings,
      emissionMatrix,
      initialProbabilities,
    } = this.buildHmmInputs(tab);

    const stateSequence = this.runViterbi(
      observations,
      stateFingerings,
      emissionMatrix,
      initialProbabilities,
    );

    return this.populateTabNotes(tab, stateFingerings, eventSequenceMappings, stateSequence);
  }

  private buildHmmInputs(tab: TabJson): BuildHmmResult {
    const observations: number[] = [];
    const stateFingerings: Note[][] = [];
    const eventSequenceMappings: EventSequenceMapping[] = [];
    const stateIndexByKey = new Map<string, number>();
    const emissionMatrix: number[][] = [];
    let firstObservationStates: number[] | null = null;

    for (const measure of this.measures) {
      const resultMeasure = { events: [] as TabEvent[] };

      for (const [eventTick, eventTypes] of measure.timeline.entries()) {
        const event: TabEvent = {
          time: this.midi.ticksToSeconds(eventTick),
          time_ticks: eventTick,
          measure_timing: (eventTick - measure.measureStart) / measure.durationTicks,
        };

        if (eventTypes.time_signature) {
          event.time_signature_change = [
            eventTypes.time_signature.numerator,
            eventTypes.time_signature.denominator,
          ];
        }

        if (eventTypes.notes) {
          event.notes = [];
          const candidates = this.createEventCandidates(eventTypes.notes);

          if (candidates.length > 0) {
            const observationIndex = observations.length;
            observations.push(observationIndex);

            for (const row of emissionMatrix) {
              row.push(EPSILON);
            }

            const metadataByState = new Map<number, EventStateMetadata>();

            for (const candidate of candidates) {
              for (const fingering of candidate.fingerings) {
                const stateIndex = this.getOrCreateStateIndex(
                  fingering,
                  stateFingerings,
                  stateIndexByKey,
                  emissionMatrix,
                  observations.length,
                );

                const currentEmission = emissionMatrix[stateIndex][observationIndex];
                if (candidate.emission > currentEmission) {
                  emissionMatrix[stateIndex][observationIndex] = candidate.emission;
                }

                const previousMeta = metadataByState.get(stateIndex);
                if (!previousMeta || candidate.emission > previousMeta.emission) {
                  metadataByState.set(stateIndex, {
                    emission: candidate.emission,
                    diagnostics: {
                      originalNotes: candidate.originalPitches,
                      mergedNotes: candidate.mergedPitches,
                      keptNotes: candidate.keptPitches,
                      droppedNotes: candidate.droppedPitches,
                      droppedNotesCount: candidate.droppedNotes,
                      droppedWeight: candidate.droppedWeight,
                      dropCost: candidate.dropCost,
                      selectedSubsetId: candidate.subsetId,
                      candidateCount: candidates.length,
                    },
                  });
                }
              }
            }

            if (firstObservationStates === null) {
              firstObservationStates = [...metadataByState.keys()];
            }

            eventSequenceMappings.push({ event, metadataByState });
          } else if (this.softOptions.includeEventDiagnostics) {
            const ranked = this.rankEventNotes(eventTypes.notes);
            event.processing = {
              originalNotes: ranked.map((note) => note.pitch),
              mergedNotes: ranked.map((note) => note.pitch),
              keptNotes: [],
              droppedNotes: ranked.map((note) => note.pitch),
              droppedNotesCount: ranked.length,
              droppedWeight: 1,
              dropCost: this.softOptions.dropPenalty,
              selectedSubsetId: "none",
              candidateCount: 0,
            };
          }
        }

        resultMeasure.events.push(event);
      }

      tab.measures.push(resultMeasure);
    }

    const initialProbabilities = this.buildInitialDistribution(
      stateFingerings,
      firstObservationStates,
    );

    return {
      observations,
      stateFingerings,
      eventSequenceMappings,
      emissionMatrix,
      initialProbabilities,
    };
  }

  private runViterbi(
    observations: number[],
    stateFingerings: Note[][],
    emissionMatrix: number[][],
    initialProbabilities: number[] | null,
  ): number[] {
    if (observations.length === 0 || stateFingerings.length === 0 || emissionMatrix.length === 0) {
      return [];
    }

    const transitionMatrix = buildTransitionMatrix(
      this.fretboard.positions,
      stateFingerings,
      this.weights,
      this.tuning,
    );

    const initial = initialProbabilities ?? Array(transitionMatrix.length).fill(1 / transitionMatrix.length);
    return viterbi(observations, transitionMatrix, emissionMatrix, initial);
  }

  private populateTabNotes(
    tab: TabJson,
    stateFingerings: Note[][],
    eventSequenceMappings: EventSequenceMapping[],
    stateSequence: number[],
  ): TabJson {
    for (let i = 0; i < eventSequenceMappings.length; i++) {
      const mapping = eventSequenceMappings[i];
      const event = mapping.event;
      const stateIndex = stateSequence[i];
      const fingering = stateFingerings[stateIndex] ?? [];

      for (const pathNote of fingering) {
        const position = this.fretboard.positions.get(pathNote);
        if (!position || !event.notes) {
          continue;
        }

        const [string, fret] = position;
        event.notes.push({
          degree: pathNote.degree,
          octave: pathNote.octave,
          string,
          fret,
        });
      }

      if (this.softOptions.includeEventDiagnostics) {
        const selectedMeta = mapping.metadataByState.get(stateIndex);
        if (selectedMeta) {
          event.processing = selectedMeta.diagnostics;
        }
      }
    }

    return tab;
  }

  private clusterNotesByOnset(notes: MidiNoteEvent[]): MidiNoteEvent[][] {
    if (notes.length === 0) {
      return [];
    }

    const clusters: MidiNoteEvent[][] = [];
    let currentCluster: MidiNoteEvent[] = [notes[0]];
    let anchorTick = notes[0].startTicks;

    for (let i = 1; i < notes.length; i++) {
      const note = notes[i];
      if (note.startTicks - anchorTick <= this.softOptions.onsetMergeWindowTicks) {
        currentCluster.push(note);
      } else {
        clusters.push(currentCluster);
        currentCluster = [note];
        anchorTick = note.startTicks;
      }
    }

    clusters.push(currentCluster);
    return clusters;
  }

  private aggregateClusterNotes(cluster: MidiNoteEvent[]): MidiNoteEvent[] {
    const byPitch = new Map<
      number,
      { velocity: number; startTicks: number; endTicks: number }
    >();

    for (const note of cluster) {
      const current = byPitch.get(note.pitch);
      if (!current) {
        byPitch.set(note.pitch, {
          velocity: note.velocity,
          startTicks: note.startTicks,
          endTicks: note.endTicks,
        });
      } else {
        current.velocity = Math.max(current.velocity, note.velocity);
        current.startTicks = Math.min(current.startTicks, note.startTicks);
        current.endTicks = Math.max(current.endTicks, note.endTicks);
      }
    }

    return [...byPitch.entries()]
      .map(([pitch, agg]) => ({
        pitch,
        velocity: agg.velocity,
        startTicks: agg.startTicks,
        endTicks: agg.endTicks,
        startTime: this.midi.ticksToSeconds(agg.startTicks),
        endTime: this.midi.ticksToSeconds(agg.endTicks),
      }))
      .sort((a, b) => a.pitch - b.pitch || a.startTicks - b.startTicks);
  }

  private rankEventNotes(notes: MidiNoteEvent[]): RankedEventNote[] {
    const byPitch = new Map<number, RankedEventNote>();

    for (const note of notes) {
      const durationTicks = Math.max(1, note.endTicks - note.startTicks);
      const current = byPitch.get(note.pitch);
      if (!current) {
        byPitch.set(note.pitch, {
          pitch: note.pitch,
          velocity: note.velocity,
          startTicks: note.startTicks,
          durationTicks,
          importance: 0,
        });
      } else {
        current.velocity = Math.max(current.velocity, note.velocity);
        current.startTicks = Math.min(current.startTicks, note.startTicks);
        current.durationTicks = Math.max(current.durationTicks, durationTicks);
      }
    }

    const ranked = [...byPitch.values()].sort((a, b) => a.pitch - b.pitch);
    if (ranked.length === 0) {
      return ranked;
    }

    const maxDuration = Math.max(...ranked.map((note) => note.durationTicks), 1);
    const lowestPitch = ranked[0].pitch;
    const highestPitch = ranked[ranked.length - 1].pitch;
    const minStartTick = Math.min(...notes.map((note) => note.startTicks));
    const maxStartTick = Math.max(...notes.map((note) => note.startTicks));
    const onsetRange = Math.max(1, maxStartTick - minStartTick);

    for (const note of ranked) {
      const velocityScore = note.velocity / 127;
      const durationScore = note.durationTicks / maxDuration;
      const rangeBonus = note.pitch === lowestPitch || note.pitch === highestPitch ? 1.5 : 0;
      const onsetDelta = Math.abs(note.startTicks - minStartTick);
      const onsetStability = 1 - Math.min(1, onsetDelta / onsetRange);
      note.importance = velocityScore + durationScore + rangeBonus + onsetStability * 0.6;
    }

    return ranked;
  }

  private limitPolyphony(notes: RankedEventNote[]): {
    kept: RankedEventNote[];
    dropped: RankedEventNote[];
  } {
    if (notes.length <= this.softOptions.maxNotesPerEvent) {
      return { kept: [...notes], dropped: [] };
    }

    const scored = [...notes].sort(
      (a, b) => b.importance - a.importance || b.pitch - a.pitch,
    );
    const keptSet = new Set(scored.slice(0, this.softOptions.maxNotesPerEvent).map((note) => note.pitch));
    const kept = notes.filter((note) => keptSet.has(note.pitch));
    const dropped = notes.filter((note) => !keptSet.has(note.pitch));

    return { kept, dropped };
  }

  private createEventCandidates(eventNotes: MidiNoteEvent[]): EventCandidate[] {
    const rankedOriginal = this.rankEventNotes(eventNotes);
    if (rankedOriginal.length === 0) {
      return [];
    }

    const originalPitches = rankedOriginal.map((note) => note.pitch);
    const { kept: polyKept, dropped: polyDropped } = this.limitPolyphony(rankedOriginal);
    const mergedPitches = polyKept.map((note) => note.pitch);

    if (polyKept.length === 0) {
      return [];
    }

    const totalImportance = rankedOriginal.reduce((acc, note) => acc + note.importance, 0);
    const noteByPitch = new Map(rankedOriginal.map((note) => [note.pitch, note]));

    const subsetPools = this.softOptions.allowNoteDrop
      ? this.generateSubsetPool(polyKept)
      : [polyKept];

    const candidates = this.evaluateSubsetPool(
      subsetPools,
      originalPitches,
      mergedPitches,
      noteByPitch,
      totalImportance,
      polyDropped,
    );

    if (candidates.length > 0 || this.softOptions.fallbackStrategy === "none") {
      return candidates;
    }

    const fallbackPools = this.buildGreedyFallbackSubsets(polyKept);
    return this.evaluateSubsetPool(
      fallbackPools,
      originalPitches,
      mergedPitches,
      noteByPitch,
      totalImportance,
      polyDropped,
      true,
    );
  }

  private evaluateSubsetPool(
    subsetPools: RankedEventNote[][],
    originalPitches: number[],
    mergedPitches: number[],
    noteByPitch: Map<number, RankedEventNote>,
    totalImportance: number,
    polyDropped: RankedEventNote[],
    stopAtFirst = false,
  ): EventCandidate[] {
    const candidates: EventCandidate[] = [];
    const seenSubset = new Set<string>();
    const polyDroppedPitches = polyDropped.map((note) => note.pitch);

    for (const subset of subsetPools) {
      const subsetKey = subset.map((note) => note.pitch).join(",");
      if (seenSubset.has(subsetKey)) {
        continue;
      }
      seenSubset.add(subsetKey);

      const subsetPitches = subset.map((note) => note.pitch).sort((a, b) => a - b);
      if (subsetPitches.length === 0) {
        continue;
      }

      const droppedPitches = originalPitches
        .filter((pitch) => !subsetPitches.includes(pitch))
        .concat(polyDroppedPitches.filter((pitch) => !subsetPitches.includes(pitch)))
        .filter((pitch, index, arr) => arr.indexOf(pitch) === index)
        .sort((a, b) => a - b);

      const droppedImportance = droppedPitches.reduce(
        (acc, pitch) => acc + (noteByPitch.get(pitch)?.importance ?? 0),
        0,
      );
      const droppedWeight = totalImportance > 0 ? droppedImportance / totalImportance : 0;
      const droppedNotes = droppedPitches.length;

      const notes = this.fretboard.fixOobNotes(
        subsetPitches.map((pitch) => new Note(pitch)),
        false,
      );
      const noteOptions = this.fretboard.getNoteOptions(notes);
      const fingerings = this.fretboard.getPossibleFingerings(noteOptions);

      if (fingerings.length === 0) {
        continue;
      }

      const { emission, dropCost } = this.computeSoftEmission(droppedNotes, droppedWeight);
      candidates.push({
        subsetId: subsetKey,
        originalPitches,
        mergedPitches,
        keptPitches: subsetPitches,
        droppedPitches,
        droppedNotes,
        droppedWeight,
        dropCost,
        emission,
        fingerings,
      });

      if (stopAtFirst) {
        break;
      }
    }

    return candidates;
  }

  private computeSoftEmission(droppedNotes: number, droppedWeight: number): { emission: number; dropCost: number } {
    const dropCost = droppedNotes > 0 ? this.softOptions.dropPenalty : 0;
    const exponent =
      this.softOptions.alpha * droppedNotes + this.softOptions.beta * droppedWeight + dropCost;
    return { emission: Math.max(EPSILON, Math.exp(-exponent)), dropCost };
  }

  private generateSubsetPool(notes: RankedEventNote[]): RankedEventNote[][] {
    const total = notes.length;
    const subsets: Array<{ subset: RankedEventNote[]; droppedCount: number; droppedWeight: number }> = [];
    const totalImportance = notes.reduce((acc, note) => acc + note.importance, 0);

    for (let mask = 1; mask < 1 << total; mask++) {
      const subset: RankedEventNote[] = [];
      let droppedImportance = 0;

      for (let i = 0; i < total; i++) {
        if ((mask & (1 << i)) !== 0) {
          subset.push(notes[i]);
        } else {
          droppedImportance += notes[i].importance;
        }
      }

      const droppedCount = total - subset.length;
      const droppedWeight = totalImportance > 0 ? droppedImportance / totalImportance : 0;
      subsets.push({ subset, droppedCount, droppedWeight });
    }

    subsets.sort(
      (a, b) =>
        a.droppedCount - b.droppedCount ||
        a.droppedWeight - b.droppedWeight ||
        b.subset.length - a.subset.length,
    );

    return subsets
      .slice(0, this.softOptions.maxSubsetCandidates)
      .map((entry) => [...entry.subset].sort((a, b) => a.pitch - b.pitch));
  }

  private buildGreedyFallbackSubsets(notes: RankedEventNote[]): RankedEventNote[][] {
    const byImportance = [...notes].sort((a, b) => a.importance - b.importance || a.pitch - b.pitch);
    const subsets: RankedEventNote[][] = [];

    for (let removeCount = 0; removeCount < byImportance.length; removeCount++) {
      const removed = new Set(byImportance.slice(0, removeCount).map((note) => note.pitch));
      const subset = notes
        .filter((note) => !removed.has(note.pitch))
        .sort((a, b) => a.pitch - b.pitch);
      if (subset.length > 0) {
        subsets.push(subset);
      }
    }

    return subsets;
  }

  private getOrCreateStateIndex(
    fingering: Note[],
    stateFingerings: Note[][],
    stateIndexByKey: Map<string, number>,
    emissionMatrix: number[][],
    nObservations: number,
  ): number {
    const key = fingering
      .map((note) => note.id)
      .sort((a, b) => a - b)
      .join(",");

    const cached = stateIndexByKey.get(key);
    if (typeof cached === "number") {
      return cached;
    }

    const stateIndex = stateFingerings.length;
    stateFingerings.push(fingering);
    stateIndexByKey.set(key, stateIndex);
    emissionMatrix.push(Array(nObservations).fill(EPSILON));
    return stateIndex;
  }

  private buildInitialDistribution(
    stateFingerings: Note[][],
    firstObservationStates: number[] | null,
  ): number[] | null {
    if (stateFingerings.length === 0) {
      return null;
    }

    if (!firstObservationStates || firstObservationStates.length === 0) {
      return Array(stateFingerings.length).fill(1 / stateFingerings.length);
    }

    const isolatedDifficulties = firstObservationStates.map((stateIndex) =>
      computeIsolatedPathDifficulty(this.fretboard.positions, stateFingerings[stateIndex], this.tuning),
    );
    const firstProbs = difficultiesToProbabilities(isolatedDifficulties);

    const initial = Array(stateFingerings.length).fill(EPSILON);
    for (let i = 0; i < firstObservationStates.length; i++) {
      initial[firstObservationStates[i]] = Math.max(EPSILON, firstProbs[i]);
    }

    const sum = initial.reduce((acc, value) => acc + value, 0);
    return initial.map((value) => value / sum);
  }

  toStringLines(): string[] {
    let result = this.tuning.strings.map(
      (string) => `${string.degree}${string.degree.length > 1 ? "||" : " ||"}`,
    );

    for (const measure of this.tab.measures) {
      for (let i = 0; i < measure.events.length; i++) {
        const event = measure.events[i];
        if (!event.notes) {
          continue;
        }

        for (const note of event.notes) {
          result[note.string] += String(note.fret);
        }

        const nextTiming = i < measure.events.length - 1 ? measure.events[i + 1].measure_timing : 1;
        const dashesToAdd = Math.max(1, Math.floor((nextTiming - event.measure_timing) * 16));

        result = fillMeasureStr(result);
        for (let string = 0; string < this.nstrings; string++) {
          result[string] += "-".repeat(dashesToAdd);
        }
      }

      for (let string = 0; string < this.nstrings; string++) {
        result[string] += "|";
      }
    }

    return result;
  }

  toAsciiString(): string {
    return `${this.toStringLines().join("\n")}\n`;
  }

  toJsonString(pretty = true): string {
    return JSON.stringify(this.tab, null, pretty ? 2 : 0);
  }
}
