import { z } from "zod";
import type { Difficulty } from "./chart";

export const LeaderboardSchema = z.object({
  rows: z.array(
    z.object({
      rank: z.number(),
      nickname: z.string(),
      score: z.number(),
      accuracy: z.number(),
      maxCombo: z.number(),
      fullCombo: z.boolean(),
      playerId: z.string(),
    }),
  ),
  me: z.object({ rank: z.number(), score: z.number() }).nullable(),
  storage: z.enum(["postgres", "memory"]),
});
export type Leaderboard = z.infer<typeof LeaderboardSchema>;

export const SubmitResultSchema = z.object({
  improved: z.boolean(),
  previous: z.number().nullable(),
  best: z.number(),
  rank: z.number().nullable(),
  storage: z.enum(["postgres", "memory"]),
});
export type SubmitResult = z.infer<typeof SubmitResultSchema>;

export interface SubmitPayload {
  songId: string;
  difficulty: Difficulty;
  playerId: string;
  nickname: string;
  score: number;
  accuracy: number;
  maxCombo: number;
  fullCombo: boolean;
  counts: { perfect: number; great: number; good: number; miss: number };
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(url: string, schema: z.ZodType<T>, init?: RequestInit): Promise<Result<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { ...init, cache: "no-store", signal: ctrl.signal });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: (json && json.error) || `http_${res.status}` };
    const parsed = schema.safeParse(json);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: "bad_response" };
  } catch {
    return { ok: false, error: "network" };
  } finally {
    clearTimeout(timer);
  }
}

export function fetchLeaderboard(songId: string, difficulty: Difficulty, playerId?: string) {
  const q = new URLSearchParams({ songId, difficulty });
  if (playerId) q.set("playerId", playerId);
  return call(`/api/scores?${q}`, LeaderboardSchema);
}

export function submitScore(payload: SubmitPayload) {
  return call(`/api/scores`, SubmitResultSchema, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
