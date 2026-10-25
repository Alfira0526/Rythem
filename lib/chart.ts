import { z } from "zod";

export const DIFFICULTIES = ["easy", "normal", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: "EASY",
  normal: "NORMAL",
  hard: "HARD",
};

/** [time(sec), lane(0-3), duration(sec, 0 = tap)] */
export const NoteTupleSchema = z.tuple([
  z.number().min(0),
  z.number().int().min(0).max(3),
  z.number().min(0),
]);
export type NoteTuple = z.infer<typeof NoteTupleSchema>;

export const ChartSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().min(1),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  duration: z.number().positive(),
  bpm: z.number().positive(),
  /** time of the first beat (sec) */
  offset: z.number(),
  /** extra shift applied to all notes when playing against the YouTube video (sec). */
  videoOffset: z.number().default(0),
  difficulties: z.object({
    easy: z.array(NoteTupleSchema),
    normal: z.array(NoteTupleSchema),
    hard: z.array(NoteTupleSchema),
  }),
});
export type Chart = z.infer<typeof ChartSchema>;

export interface Note {
  index: number;
  time: number;
  lane: number;
  duration: number;
  end: number;
}

export function toNotes(tuples: NoteTuple[], shift = 0): Note[] {
  return [...tuples]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([t, lane, dur], index) => ({
      index,
      time: t + shift,
      lane,
      duration: dur,
      end: t + shift + dur,
    }));
}

export function beatLength(chart: Chart): number {
  return 60 / chart.bpm;
}
