import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ChartSchema, DIFFICULTIES } from "@/lib/chart";
import { getStore, storeKind } from "@/lib/db";
import { findSong } from "@/lib/songs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SubmitSchema = z.object({
  songId: z.string().min(1).max(64),
  difficulty: z.enum(DIFFICULTIES),
  playerId: z.string().regex(/^[a-f0-9]{16,64}$/),
  nickname: z.string().trim().min(1).max(12),
  score: z.number().int().min(0).max(1_000_000),
  accuracy: z.number().min(0).max(100),
  maxCombo: z.number().int().min(0),
  fullCombo: z.boolean(),
  counts: z.object({
    perfect: z.number().int().min(0),
    great: z.number().int().min(0),
    good: z.number().int().min(0),
    miss: z.number().int().min(0),
  }),
});

const chartCache = new Map<string, Promise<z.infer<typeof ChartSchema>>>();

function loadChart(songId: string) {
  let p = chartCache.get(songId);
  if (!p) {
    p = fs
      .readFile(path.join(process.cwd(), "public", "charts", `${songId}.json`), "utf8")
      .then((raw) => ChartSchema.parse(JSON.parse(raw)));
    chartCache.set(songId, p);
  }
  return p;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const songId = url.searchParams.get("songId") ?? "";
  const difficulty = url.searchParams.get("difficulty") ?? "";
  const playerId = url.searchParams.get("playerId");
  if (!findSong(songId) || !(DIFFICULTIES as readonly string[]).includes(difficulty)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const store = getStore();
  const rows = await store.top(songId, difficulty, 50);
  const me = playerId ? await store.rankOf(songId, difficulty, playerId) : null;
  return NextResponse.json({
    rows: rows.map((r, i) => ({
      rank: i + 1,
      nickname: r.nickname,
      score: r.score,
      accuracy: r.accuracy,
      maxCombo: r.maxCombo,
      fullCombo: r.fullCombo,
      playerId: r.playerId,
    })),
    me,
    storage: storeKind(),
  });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = SubmitSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const s = parsed.data;
  if (!findSong(s.songId)) return NextResponse.json({ error: "song_unavailable" }, { status: 404 });

  // Sanity checks against the chart: judgement counts and combo cannot exceed the note count.
  const chart = await loadChart(s.songId);
  const notes = chart.difficulties[s.difficulty];
  const totalJudgements = notes.reduce((n, [, , dur]) => n + (dur > 0 ? 2 : 1), 0);
  const judged = s.counts.perfect + s.counts.great + s.counts.good + s.counts.miss;
  const points = s.counts.perfect * 100 + s.counts.great * 80 + s.counts.good * 50;
  const expectedScore = Math.round((points / (totalJudgements * 100)) * 1_000_000);
  if (
    judged !== totalJudgements ||
    s.maxCombo > totalJudgements ||
    Math.abs(expectedScore - s.score) > 1 ||
    (s.fullCombo && s.counts.miss !== 0)
  ) {
    return NextResponse.json({ error: "inconsistent" }, { status: 422 });
  }

  const store = getStore();
  const result = await store.upsertBest({
    songId: s.songId,
    difficulty: s.difficulty,
    playerId: s.playerId,
    nickname: s.nickname,
    score: s.score,
    accuracy: s.accuracy,
    maxCombo: s.maxCombo,
    fullCombo: s.fullCombo,
    updatedAt: Date.now(),
  });
  const me = await store.rankOf(s.songId, s.difficulty, s.playerId);
  return NextResponse.json({ ...result, rank: me?.rank ?? null, storage: storeKind() });
}
