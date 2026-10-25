import { z } from "zod";

export const SPEED_LEVELS = 10;
/** seconds a note takes to travel from the top to the hit line, per speed level (1 = slowest) */
export function approachFor(level: number): number {
  const l = Math.max(1, Math.min(SPEED_LEVELS, Math.round(level)));
  return Math.round((2.4 - (l - 1) * 0.2) * 100) / 100; // 2.4s … 0.6s
}

const SettingsSchema = z.object({
  /** note speed level 1–10 (see approachFor) */
  speedLevel: z.number().int().min(1).max(SPEED_LEVELS).default(6),
  /** input offset in ms, added to the song time before judging (late presser → negative) */
  offsetMs: z.number().min(-400).max(400).default(0),
  /** shifts where notes are drawn (and judged) relative to the video, ms; positive = later */
  visualOffsetMs: z.number().min(-500).max(500).default(0),
  vibrate: z.boolean().default(true),
  nickname: z.string().max(12).default(""),
});
export type Settings = z.infer<typeof SettingsSchema>;

const KEY = "rhythm-lane.settings";
const PLAYER_KEY = "rhythm-lane.playerId";
const LOCAL_BEST_KEY = "rhythm-lane.localBest";
const UNLOCK_KEY = "rhythm-lane.unlocks";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadSettings(): Settings {
  const raw = storage()?.getItem(KEY);
  if (!raw) return SettingsSchema.parse({});
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    // migrate the old continuous "approach" (seconds) to the nearest speed level
    if (typeof obj.approach === "number" && obj.speedLevel === undefined) {
      obj.speedLevel = Math.max(1, Math.min(SPEED_LEVELS, Math.round((2.4 - obj.approach) / 0.2) + 1));
    }
    return SettingsSchema.parse(obj);
  } catch {
    return SettingsSchema.parse({});
  }
}

export function saveSettings(s: Settings) {
  storage()?.setItem(KEY, JSON.stringify(s));
}

export function getPlayerId(): string {
  const s = storage();
  let id = s?.getItem(PLAYER_KEY) ?? null;
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().replace(/-/g, "")
        : Math.random().toString(16).slice(2) + Date.now().toString(16);
    s?.setItem(PLAYER_KEY, id);
  }
  return id;
}

export type LocalBest = Record<string, number>; // key = `${songId}:${difficulty}`

export function loadLocalBest(): LocalBest {
  try {
    return JSON.parse(storage()?.getItem(LOCAL_BEST_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveLocalBest(songId: string, difficulty: string, score: number): boolean {
  const all = loadLocalBest();
  const key = `${songId}:${difficulty}`;
  if ((all[key] ?? 0) >= score) return false;
  all[key] = score;
  storage()?.setItem(LOCAL_BEST_KEY, JSON.stringify(all));
  return true;
}

export type Unlocks = Record<string, true>; // key = `${songId}:${difficulty}`

export function loadUnlocks(): Unlocks {
  try {
    return JSON.parse(storage()?.getItem(UNLOCK_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** Returns true when this call newly unlocked the key. */
export function saveUnlock(songId: string, difficulty: string): boolean {
  const all = loadUnlocks();
  const key = `${songId}:${difficulty}`;
  if (all[key]) return false;
  all[key] = true;
  storage()?.setItem(UNLOCK_KEY, JSON.stringify(all));
  return true;
}
