import { z } from "zod";

const SettingsSchema = z.object({
  /** seconds a note takes to travel from the top to the hit line */
  approach: z.number().min(0.5).max(3).default(1.3),
  /** input offset in ms; positive = judge later */
  offsetMs: z.number().min(-400).max(400).default(0),
  /** shifts where notes are drawn (and judged) relative to the video, ms; positive = later */
  visualOffsetMs: z.number().min(-500).max(500).default(0),
  /** how many hits a calibration run collects before computing the offset */
  calibrationNotes: z.number().int().min(8).max(64).default(16),
  vibrate: z.boolean().default(true),
  nickname: z.string().max(12).default(""),
});
export type Settings = z.infer<typeof SettingsSchema>;

const KEY = "rhythm-lane.settings";
const PLAYER_KEY = "rhythm-lane.playerId";
const LOCAL_BEST_KEY = "rhythm-lane.localBest";

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
    return SettingsSchema.parse(JSON.parse(raw));
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
