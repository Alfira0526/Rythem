import type { Difficulty } from "./chart";

/* ---------- Gameplay tuning, one place for every per-difficulty number ---------- */

/** judgement windows in seconds (generous: the clock comes from a YouTube embed) */
export const WINDOW = { perfect: 0.065, great: 0.115, good: 0.17 } as const;

/** released this early before a hold's tail counts as dropping it (sec) */
export const HOLD_RELEASE_GRACE = 0.14;

export interface DifficultyRule {
  /** HP lost per MISS */
  miss: number;
  /** HP gained per PERFECT */
  heal: number;
  /** multiplier on the player's note-fall time (1 = as set, <1 = faster) */
  approachScale: number;
}

export const DIFFICULTY_RULE: Record<Difficulty, DifficultyRule> = {
  easy: { miss: 4, heal: 1.0, approachScale: 1.15 },
  normal: { miss: 6, heal: 0.7, approachScale: 1.0 },
  hard: { miss: 8, heal: 0.5, approachScale: 0.9 },
  extreme: { miss: 10, heal: 0.4, approachScale: 0.8 },
};
