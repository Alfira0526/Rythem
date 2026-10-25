import postgres from "postgres";

export interface ScoreRow {
  songId: string;
  difficulty: string;
  playerId: string;
  nickname: string;
  score: number;
  accuracy: number;
  maxCombo: number;
  fullCombo: boolean;
  updatedAt: number;
}

export interface ScoreStore {
  /** Returns true when the stored best improved. */
  upsertBest(row: ScoreRow): Promise<{ improved: boolean; previous: number | null; best: number }>;
  top(songId: string, difficulty: string, limit: number): Promise<ScoreRow[]>;
  rankOf(songId: string, difficulty: string, playerId: string): Promise<{ rank: number; score: number } | null>;
}

/* ---------- in-memory fallback (dev / no DATABASE_URL) ---------- */

class MemoryStore implements ScoreStore {
  private rows = new Map<string, ScoreRow>();
  private key(r: { songId: string; difficulty: string; playerId: string }) {
    return `${r.songId}|${r.difficulty}|${r.playerId}`;
  }
  async upsertBest(row: ScoreRow) {
    const k = this.key(row);
    const prev = this.rows.get(k) ?? null;
    if (prev && prev.score >= row.score) {
      this.rows.set(k, { ...prev, nickname: row.nickname });
      return { improved: false, previous: prev.score, best: prev.score };
    }
    this.rows.set(k, row);
    return { improved: true, previous: prev?.score ?? null, best: row.score };
  }
  private sorted(songId: string, difficulty: string) {
    return [...this.rows.values()]
      .filter((r) => r.songId === songId && r.difficulty === difficulty)
      .sort((a, b) => b.score - a.score || a.updatedAt - b.updatedAt);
  }
  async top(songId: string, difficulty: string, limit: number) {
    return this.sorted(songId, difficulty).slice(0, limit);
  }
  async rankOf(songId: string, difficulty: string, playerId: string) {
    const list = this.sorted(songId, difficulty);
    const i = list.findIndex((r) => r.playerId === playerId);
    return i < 0 ? null : { rank: i + 1, score: list[i].score };
  }
}

/* ---------- Postgres ---------- */

class PgStore implements ScoreStore {
  private sql: ReturnType<typeof postgres>;
  private ready: Promise<void>;
  constructor(url: string) {
    this.sql = postgres(url, { max: 3, idle_timeout: 20, prepare: false });
    this.ready = this.sql`
      CREATE TABLE IF NOT EXISTS scores (
        song_id    text NOT NULL,
        difficulty text NOT NULL,
        player_id  text NOT NULL,
        nickname   text NOT NULL,
        score      integer NOT NULL,
        accuracy   real NOT NULL,
        max_combo  integer NOT NULL,
        full_combo boolean NOT NULL,
        updated_at bigint NOT NULL,
        PRIMARY KEY (song_id, difficulty, player_id)
      )`.then(() => undefined);
  }
  private map(r: Record<string, unknown>): ScoreRow {
    return {
      songId: String(r.song_id),
      difficulty: String(r.difficulty),
      playerId: String(r.player_id),
      nickname: String(r.nickname),
      score: Number(r.score),
      accuracy: Number(r.accuracy),
      maxCombo: Number(r.max_combo),
      fullCombo: Boolean(r.full_combo),
      updatedAt: Number(r.updated_at),
    };
  }
  async upsertBest(row: ScoreRow) {
    await this.ready;
    const prev = await this.sql`
      SELECT score FROM scores
      WHERE song_id=${row.songId} AND difficulty=${row.difficulty} AND player_id=${row.playerId}`;
    const previous = prev.length ? Number(prev[0].score) : null;
    if (previous !== null && previous >= row.score) {
      await this.sql`UPDATE scores SET nickname=${row.nickname}
        WHERE song_id=${row.songId} AND difficulty=${row.difficulty} AND player_id=${row.playerId}`;
      return { improved: false, previous, best: previous };
    }
    await this.sql`
      INSERT INTO scores (song_id, difficulty, player_id, nickname, score, accuracy, max_combo, full_combo, updated_at)
      VALUES (${row.songId}, ${row.difficulty}, ${row.playerId}, ${row.nickname}, ${row.score}, ${row.accuracy},
              ${row.maxCombo}, ${row.fullCombo}, ${row.updatedAt})
      ON CONFLICT (song_id, difficulty, player_id) DO UPDATE SET
        nickname=EXCLUDED.nickname, score=EXCLUDED.score, accuracy=EXCLUDED.accuracy,
        max_combo=EXCLUDED.max_combo, full_combo=EXCLUDED.full_combo, updated_at=EXCLUDED.updated_at`;
    return { improved: true, previous, best: row.score };
  }
  async top(songId: string, difficulty: string, limit: number) {
    await this.ready;
    const rows = await this.sql`
      SELECT * FROM scores WHERE song_id=${songId} AND difficulty=${difficulty}
      ORDER BY score DESC, updated_at ASC LIMIT ${limit}`;
    return rows.map((r) => this.map(r));
  }
  async rankOf(songId: string, difficulty: string, playerId: string) {
    await this.ready;
    const rows = await this.sql`
      SELECT rank, score FROM (
        SELECT player_id, score, RANK() OVER (ORDER BY score DESC, updated_at ASC) AS rank
        FROM scores WHERE song_id=${songId} AND difficulty=${difficulty}
      ) t WHERE player_id=${playerId}`;
    return rows.length ? { rank: Number(rows[0].rank), score: Number(rows[0].score) } : null;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __scoreStore: ScoreStore | undefined;
}

export function getStore(): ScoreStore {
  if (!globalThis.__scoreStore) {
    const url = process.env.DATABASE_URL;
    globalThis.__scoreStore = url ? new PgStore(url) : new MemoryStore();
  }
  return globalThis.__scoreStore;
}

export function storeKind(): "postgres" | "memory" {
  return process.env.DATABASE_URL ? "postgres" : "memory";
}
