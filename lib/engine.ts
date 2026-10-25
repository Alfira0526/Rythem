import type { Difficulty, Note } from "./chart";

export type JudgeKind = "perfect" | "great" | "good" | "miss";

export const JUDGE_POINTS: Record<JudgeKind, number> = {
  perfect: 100,
  great: 80,
  good: 50,
  miss: 0,
};

/** Windows are generous on purpose: the clock comes from a YouTube embed. */
export const WINDOW = { perfect: 0.065, great: 0.115, good: 0.17 } as const;

export const LIFE_RULE: Record<Difficulty, { miss: number; heal: number }> = {
  easy: { miss: 5, heal: 0.8 },
  normal: { miss: 7, heal: 0.6 },
  hard: { miss: 9, heal: 0.5 },
};

/** released this early before the tail counts as dropping the hold */
const HOLD_RELEASE_GRACE = 0.14;

export interface NoteState {
  head: JudgeKind | null;
  tail: JudgeKind | null; // only for holds
  holding: boolean;
  done: boolean;
}

export interface JudgeEvent {
  kind: JudgeKind;
  lane: number;
  noteIndex: number;
  /** signed hit offset in seconds (negative = early), null for forced miss */
  offset: number | null;
  tail: boolean;
  at: number;
}

export interface Stats {
  points: number;
  maxPoints: number;
  combo: number;
  maxCombo: number;
  counts: Record<JudgeKind, number>;
  life: number;
  judged: number;
  totalJudgements: number;
  offsetSum: number;
  offsetCount: number;
}

export interface EngineOptions {
  difficulty: Difficulty;
  /** seconds added to the song time before judging (positive = judge later) */
  inputOffset: number;
  /** widest window a press can match (sec); calibration runs use a wider one */
  captureWindow?: number;
  /** calibration runs never end on empty life */
  immortal?: boolean;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class Engine {
  readonly states: NoteState[];
  readonly stats: Stats;
  readonly events: JudgeEvent[] = [];
  private cursor = 0; // first note that can still be judged
  private readonly rule: { miss: number; heal: number };
  private readonly capture: number;
  /** judgement offset in seconds (positive = judge later) */
  readonly inputOffset: number;
  /** signed offsets of every non-miss head hit, in order */
  readonly hitOffsets: number[] = [];
  retired = false;
  finished = false;

  constructor(
    readonly notes: Note[],
    private readonly opts: EngineOptions,
  ) {
    this.inputOffset = opts.inputOffset;
    this.capture = Math.max(WINDOW.good, opts.captureWindow ?? WINDOW.good);
    this.states = notes.map(() => ({ head: null, tail: null, holding: false, done: false }));
    this.rule = LIFE_RULE[opts.difficulty];
    const totalJudgements = notes.reduce((n, note) => n + (note.duration > 0 ? 2 : 1), 0);
    this.stats = {
      points: 0,
      maxPoints: totalJudgements * JUDGE_POINTS.perfect,
      combo: 0,
      maxCombo: 0,
      counts: { perfect: 0, great: 0, good: 0, miss: 0 },
      life: 100,
      judged: 0,
      totalJudgements,
      offsetSum: 0,
      offsetCount: 0,
    };
  }

  get score(): number {
    if (this.stats.maxPoints === 0) return 0;
    return Math.round((this.stats.points / this.stats.maxPoints) * 1_000_000);
  }

  get accuracy(): number {
    if (this.stats.maxPoints === 0) return 0;
    return Math.round((this.stats.points / this.stats.maxPoints) * 10000) / 100;
  }

  get fullCombo(): boolean {
    return this.stats.counts.miss === 0 && this.stats.judged === this.stats.totalJudgements;
  }

  private record(kind: JudgeKind, note: Note, offset: number | null, tail: boolean, at: number) {
    const s = this.stats;
    s.counts[kind]++;
    s.judged++;
    s.points += JUDGE_POINTS[kind];
    if (kind === "miss") {
      s.combo = 0;
      s.life = Math.max(0, s.life - this.rule.miss);
      if (s.life <= 0 && !this.opts.immortal) this.retired = true;
    } else {
      s.combo++;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
      if (kind === "perfect") s.life = Math.min(100, s.life + this.rule.heal);
      if (offset !== null && !tail) {
        s.offsetSum += offset;
        s.offsetCount++;
        this.hitOffsets.push(offset);
      }
    }
    this.events.push({ kind, lane: note.lane, noteIndex: note.index, offset, tail, at });
  }

  private kindFor(absOffset: number): JudgeKind | null {
    if (absOffset <= WINDOW.perfect) return "perfect";
    if (absOffset <= WINDOW.great) return "great";
    if (absOffset <= this.capture) return "good";
    return null;
  }

  /** Advance time: force misses for notes that scrolled past, resolve holds. */
  update(songTime: number) {
    const t = songTime + this.inputOffset;
    for (let i = this.cursor; i < this.notes.length; i++) {
      const note = this.notes[i];
      const st = this.states[i];
      if (note.time - t > this.capture) break; // nothing later is judgeable yet
      if (st.done) continue;
      if (st.head === null && t - note.time > this.capture) {
        this.record("miss", note, null, false, t);
        st.head = "miss";
        if (note.duration > 0) {
          this.record("miss", note, null, true, t);
          st.tail = "miss";
        }
        st.done = true;
      } else if (st.holding && t >= note.end) {
        this.record("perfect", note, 0, true, t);
        st.tail = "perfect";
        st.holding = false;
        st.done = true;
      }
    }
    while (this.cursor < this.notes.length && this.states[this.cursor].done) this.cursor++;
    if (this.cursor >= this.notes.length) this.finished = true;
  }

  /** A lane was pressed. Returns the judgement or null if nothing was in range. */
  press(lane: number, songTime: number): JudgeKind | null {
    const t = songTime + this.inputOffset;
    let bestIdx = -1;
    let bestAbs = Infinity;
    for (let i = this.cursor; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.time - t > this.capture) break;
      if (note.lane !== lane || this.states[i].head !== null) continue;
      const abs = Math.abs(note.time - t);
      if (abs < bestAbs) {
        bestAbs = abs;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return null;
    const kind = this.kindFor(bestAbs);
    if (!kind) return null;
    const note = this.notes[bestIdx];
    const st = this.states[bestIdx];
    st.head = kind;
    this.record(kind, note, t - note.time, false, t);
    if (note.duration > 0) st.holding = true;
    else st.done = true;
    return kind;
  }

  /** A lane was released: drops any hold in progress on that lane. */
  release(lane: number, songTime: number) {
    const t = songTime + this.inputOffset;
    for (let i = this.cursor; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.time - t > this.capture) break;
      const st = this.states[i];
      if (note.lane !== lane || !st.holding) continue;
      st.holding = false;
      if (t >= note.end - HOLD_RELEASE_GRACE) {
        this.record("perfect", note, 0, true, t);
        st.tail = "perfect";
      } else {
        this.record("miss", note, null, true, t);
        st.tail = "miss";
      }
      st.done = true;
    }
  }

  /** Average signed offset in ms over non-miss hits (positive = late). */
  averageOffsetMs(): number | null {
    if (this.stats.offsetCount < 10) return null;
    return Math.round((this.stats.offsetSum / this.stats.offsetCount) * 1000);
  }
}
