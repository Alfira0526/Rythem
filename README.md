# RHYTHM LANE

4-lane web rhythm game. Music and video come from an **official YouTube music video embed**
(YouTube IFrame API). The project never hosts or ships audio files: an audio file is used
only on your own machine to generate a first-draft chart, and is git-ignored.

## Stack

- Next.js (App Router) + React + TypeScript + Tailwind v4
- Canvas 2D renderer, no game engine
- YouTube IFrame API + a smoothed sync clock (`lib/youtube.ts`)
- Ranking API (`app/api/scores`) on Postgres, with an in-memory fallback for local dev
- Vercel Analytics (`@vercel/analytics`) mounted in the root layout
- Palette: Rose Quartz `#F7CAC9` + Serenity `#92A8D1` on a dark serenity-tinted base
- Chart generator (`tools/generate_chart.py`, librosa) and an in-browser chart editor (`/editor`)

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
```

Keyboard: `D F J K` = lanes 1–4, `Esc` = pause. On phones, tap the lanes.

## Ranking database

Set `DATABASE_URL` (Neon, Supabase, Vercel Postgres, any Postgres). `STORAGE_URL`,
`POSTGRES_URL` and `NEON_DATABASE_URL` are accepted too, so the Vercel Neon integration
works with its default prefix. The `scores` table is
created automatically. Without it, scores live in process memory and vanish on restart;
the UI shows a warning in that case.

## Deploy (Vercel)

1. Import the repo in Vercel (framework preset: Next.js, no extra settings).
2. Add a Postgres integration (Neon is free) or paste a `DATABASE_URL` env var.
3. Deploy. Share the URL.

## Test bed and promotion

`lib/songs.ts` gives every song a `status`. `live` songs are public. `test` songs, the
chart editor (`/editor`) and their leaderboards are served only to IPs listed in
`EDITOR_ALLOWED_IPS` (comma-separated; a trailing `.` or `:` allows a prefix). Open
`/api/access` on the deployed site to read the IP Vercel sees for you. With the variable
unset nothing is privileged in production; `next dev` allows everything.

Workflow for a new song: add it as `test`, calibrate its `videoOffset` in the editor,
overwrite the chart JSON, then flip `status` to `live` and deploy.

## Add or regenerate a chart

```bash
pip install librosa soundfile
python3 tools/generate_chart.py path/to/song.mp3 \
  --id my-song --title "Title" --artist "Artist" --video-id YOUTUBE_ID \
  --video-duration 155 \
  --out public/charts/my-song.json
```

Pass `--video-duration` (seconds) when the YouTube video is longer than the audio file
(intro/outro). The chart's `videoOffset` then has to be set in the editor:
play the video, press **첫 노트 맞추기** the moment the first note is heard, then fine-tune
with Space taps, download, and overwrite the JSON.

Then add the song to `lib/songs.ts`. The generator writes four difficulties
(easy / normal / hard / extreme) on the detected beat grid; expect to hand-edit the result.

## Difficulties and unlocks

EASY, NORMAL and HARD are open. **EXTREME** unlocks per song after a HARD full combo
(stored in the browser). The ranking API also refuses an EXTREME score unless that
player already has a HARD full-combo row on the leaderboard, so the unlock cannot be
faked just by editing localStorage.

## Edit a chart

Open `/editor`. Click an empty cell to add a note on the beat grid, click a note to delete it.
While the video plays, tap `Space` on the beat at least 8 times to measure the
**video offset** (the difference between the analysed audio and the YouTube video), apply it,
then download the JSON and overwrite `public/charts/<id>.json`.

## Rules

| judgement | window | points |
|---|---|---|
| PERFECT | ±65 ms | 100 |
| GREAT | ±115 ms | 80 |
| GOOD | ±170 ms | 50 |
| MISS | — | 0 |

Score = points / max points × 1,000,000. HP starts at 100; MISS costs 4 / 6 / 8 / 10
(easy / normal / hard / extreme), PERFECT heals 1.0 / 0.7 / 0.5 / 0.4; HP 0 = game over.
Notes fall 15 % slower on EASY and 10 % / 20 % faster on HARD / EXTREME than the
player's setting. Every per-difficulty number lives in `lib/difficulty.ts`; chart density
rules live in `DIFFICULTY_PARAMS` at the top of `tools/generate_chart.py` and can be
overridden per run with `--tune level.key=value`.
Hold notes are judged at the head and again at the tail (release too early = MISS).
Windows are deliberately wide because the clock comes from a YouTube embed.

## Timing calibration

Settings → **타이밍 보정**. Enter how many notes the run should collect (8–64, default 16)
and press **보정 시작**. The game plays the EASY chart against the video with a wide capture
window and no HP loss; once that many notes are hit it shows the median hit offset and the
new judgement offset (**판정 오프셋**) for you to apply, re-measure or cancel.
**노트 위치 보정** shifts where notes are drawn when they look early/late against the video.
All UI text lives in `lib/strings.ts`.
