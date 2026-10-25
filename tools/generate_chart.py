#!/usr/bin/env python3
"""Generate a first-draft chart from an audio file.

    python3 tools/generate_chart.py audio/song.mp3 \
        --id 12-oclock --title "12 o'clock" --artist "..." --video-id hdwGWGSfABA \
        --out public/charts/12-oclock.json

The audio file is only analysed locally; it is never copied into the project.
Difficulty rules:
  easy   : one note per beat in loud sections, every 2nd beat elsewhere
  normal : beats + the stronger off-beat onsets (8th-note feel), some holds
  hard   : most detected onsets (up to 16ths), more holds, occasional chords
  extreme: nearly every onset on a 16th grid, frequent chords, holds (unlocked by a HARD full combo)
Lane choice follows the onset's spectral centroid (low -> left, high -> right)
with a no-repeat rule so hands alternate.
"""
import argparse, json, math, sys
import numpy as np
import librosa

# ---------------------------------------------------------------------------
# Per-difficulty density rules. Override any value per run with
#   --tune hard.chord_pct=85 --tune easy.beat_every=1
#   beat_every   : keep every Nth beat (easy only)
#   loud_every   : keep every Nth beat inside loud sections (easy only)
#   onset_pct    : onsets stronger than this percentile are added (None = beats only)
#   grid         : snap added onsets to 1/grid of a beat (2 = 8ths, 4 = 16ths)
#   min_gap_beats: minimum spacing between consecutive notes, in beats
#   chord_pct    : onsets stronger than this percentile get a second lane (None = never)
#   chord_gap    : minimum gap after a chord, in beats
#   holds        : allow hold notes
# ---------------------------------------------------------------------------
DIFFICULTY_PARAMS = {
    "easy":    dict(beat_every=4, loud_every=2, onset_pct=None, grid=1, min_gap_beats=0.9,  chord_pct=None, chord_gap=1.0,  holds=False),
    "normal":  dict(beat_every=1, loud_every=1, onset_pct=None, grid=1, min_gap_beats=0.9,  chord_pct=None, chord_gap=1.0,  holds=True),
    "hard":    dict(beat_every=1, loud_every=1, onset_pct=55,   grid=2, min_gap_beats=0.45, chord_pct=90,   chord_gap=0.9,  holds=True),
    "extreme": dict(beat_every=1, loud_every=1, onset_pct=15,   grid=4, min_gap_beats=0.22, chord_pct=70,   chord_gap=0.45, holds=True),
}


def analyse(path):
    y, sr = librosa.load(path, sr=22050, mono=True)
    duration = len(y) / sr
    hop = 512
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, onset_envelope=onset_env, hop_length=hop, trim=False)
    tempo = float(np.atleast_1d(tempo)[0])
    beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, onset_envelope=onset_env, hop_length=hop, backtrack=False)
    onsets = librosa.frames_to_time(onset_frames, sr=sr, hop_length=hop)
    strength = onset_env[onset_frames]
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop)[0]
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
    return dict(duration=duration, tempo=tempo, beats=beats, onsets=onsets, strength=strength,
                centroid=centroid, rms=rms, times=times, onset_env=onset_env, hop=hop, sr=sr)


def at(times, series, t):
    i = int(np.clip(np.searchsorted(times, t), 0, len(series) - 1))
    return float(series[i])


def lane_for(centroid_value, lo, hi, rng, prev_lane):
    # map centroid to 0..3, left = low
    x = (centroid_value - lo) / max(1e-6, hi - lo)
    lane = int(np.clip(math.floor(x * 4), 0, 3))
    if lane == prev_lane:
        # move to a neighbouring lane, prefer the other hand
        options = [l for l in (lane - 1, lane + 1, (lane + 2) % 4) if 0 <= l < 4]
        lane = options[rng.integers(len(options))]
    return lane


def build(a, level, rng, params):
    P = params[level]
    beats = a["beats"]
    beat = float(np.median(np.diff(beats))) if len(beats) > 1 else 60 / a["tempo"]
    onsets, strength = a["onsets"], a["strength"]
    rms, times, cent = a["rms"], a["times"], a["centroid"]
    loud = np.percentile(rms, 60)
    s_hi = np.percentile(strength, 55)
    s_mid = np.percentile(strength, 35)
    c_lo, c_hi = np.percentile(cent, 10), np.percentile(cent, 90)
    env_t = librosa.frames_to_time(np.arange(len(a["onset_env"])), sr=a["sr"], hop_length=a["hop"])

    cand = []  # (time, weight)
    for i, b in enumerate(beats):
        is_loud = at(times, rms, b) >= loud
        every = P["loud_every"] if is_loud else P["beat_every"]
        if i % max(1, every) == 0:
            cand.append((float(b), at(env_t, a["onset_env"], b)))
    if P["onset_pct"] is not None:
        thr = np.percentile(strength, P["onset_pct"])
        div = P["grid"]
        for t, w in zip(onsets, strength):
            if w < thr:
                continue
            nearest_beat = beats[np.argmin(np.abs(beats - t))]
            snapped = nearest_beat + round((t - nearest_beat) / (beat / div)) * (beat / div)
            cand.append((float(snapped), float(w)))
    cand.sort()
    min_gap = beat * P["min_gap_beats"]
    merged = []
    for t, w in cand:
        if merged and t - merged[-1][0] < min_gap:
            if w > merged[-1][1]:
                merged[-1] = (t, w)
            continue
        merged.append((t, w))
    cand = merged

    # drop anything before the first real sound or after the end
    first_sound = float(times[np.argmax(rms > 0.01)])
    cand = [(t, w) for t, w in cand if t >= max(0.8, first_sound - 0.05) and t <= a["duration"] - 0.5]

    notes = []
    prev_lane = -1
    chord_thr = np.percentile(strength, P["chord_pct"]) if P["chord_pct"] is not None else None
    for i, (t, w) in enumerate(cand):
        lane = lane_for(at(times, cent, t), c_lo, c_hi, rng, prev_lane)
        dur = 0.0
        gap = (cand[i + 1][0] - t) if i + 1 < len(cand) else 0
        nxt_w = cand[i + 1][1] if i + 1 < len(cand) else 0
        if (P["holds"] and gap >= beat * 0.95 and w >= s_hi and nxt_w < s_mid
                and at(times, rms, t + gap * 0.6) >= loud * 0.8):
            # a strong hit followed by sustained sound and a weak next onset: hold it
            dur = round(min(gap + beat * 0.5, beat * 3), 3)
        notes.append([round(t, 3), lane, dur])
        if chord_thr is not None and w >= chord_thr and gap >= beat * P["chord_gap"]:
            other = (lane + 2) % 4 if level == "hard" else (lane + 1 + rng.integers(3)) % 4
            notes.append([round(t, 3), int(other), 0.0])
        prev_lane = lane
    notes.sort(key=lambda n: (n[0], n[1]))
    return notes, beat


def main():
    p = argparse.ArgumentParser()
    p.add_argument("audio")
    p.add_argument("--id", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--artist", required=True)
    p.add_argument("--video-id", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--video-duration", type=float, default=None,
                   help="length of the YouTube video in seconds when it differs from the audio file")
    p.add_argument("--video-offset", type=float, default=0.0,
                   help="seconds to shift every note so the chart lines up with the video (e.g. intro length)")
    p.add_argument("--tune", action="append", default=[], metavar="LEVEL.KEY=VALUE",
                   help="override a DIFFICULTY_PARAMS entry, e.g. --tune hard.chord_pct=85")
    args = p.parse_args()

    params = {k: dict(v) for k, v in DIFFICULTY_PARAMS.items()}
    for item in args.tune:
        key, _, val = item.partition("=")
        level, _, name = key.partition(".")
        if level not in params or name not in params[level]:
            sys.exit(f"unknown --tune target {key}")
        cur = params[level][name]
        if val.lower() in ("none", "null"):
            params[level][name] = None
        elif isinstance(cur, bool):
            params[level][name] = val.lower() in ("1", "true", "yes")
        elif isinstance(cur, int) and not isinstance(cur, bool):
            params[level][name] = int(float(val))
        else:
            params[level][name] = float(val)

    a = analyse(args.audio)
    rng = np.random.default_rng(args.seed)
    diffs = {}
    beat = 60 / a["tempo"]
    for level in ("easy", "normal", "hard", "extreme"):
        notes, beat = build(a, level, rng, params)
        diffs[level] = notes
    chart = {
        "id": args.id,
        "title": args.title,
        "artist": args.artist,
        "videoId": args.video_id,
        "duration": round(args.video_duration if args.video_duration else a["duration"], 3),
        "audioDuration": round(a["duration"], 3),
        "bpm": round(60 / beat, 2),
        "offset": round(float(a["beats"][0]), 3) if len(a["beats"]) else 0.0,
        "videoOffset": round(args.video_offset, 3),
        "difficulties": diffs,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(chart, f, ensure_ascii=False, separators=(",", ":"))
    print(json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in
                      {**chart, **{"difficulties": None}, **{f"notes_{k}": v for k, v in diffs.items()}}.items()
                      if v is not None}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    sys.exit(main())
