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


def build(a, level, rng):
    beats = a["beats"]
    beat = float(np.median(np.diff(beats))) if len(beats) > 1 else 60 / a["tempo"]
    onsets, strength = a["onsets"], a["strength"]
    rms, times, cent = a["rms"], a["times"], a["centroid"]
    loud = np.percentile(rms, 60)
    s_hi = np.percentile(strength, 55)
    s_mid = np.percentile(strength, 35)
    s_lo = np.percentile(strength, 15)
    c_lo, c_hi = np.percentile(cent, 10), np.percentile(cent, 90)

    cand = []  # (time, weight)
    if level == "easy":
        for i, b in enumerate(beats):
            if at(times, rms, b) >= loud or i % 2 == 0:
                cand.append((float(b), 1.0))
    else:
        env_t = librosa.frames_to_time(np.arange(len(a["onset_env"])), sr=a["sr"], hop_length=a["hop"])
        for b in beats:
            cand.append((float(b), at(env_t, a["onset_env"], b)))
        thr = {"normal": s_hi, "hard": s_mid, "extreme": s_lo}[level]
        min_gap = beat / 4 * 0.9 if level in ("hard", "extreme") else beat / 2 * 0.9
        for t, s in zip(onsets, strength):
            if s < thr:
                continue
            # snap to the nearest 16th (hard) / 8th (normal) grid
            div = 4 if level in ("hard", "extreme") else 2
            nearest_beat = beats[np.argmin(np.abs(beats - t))]
            snapped = nearest_beat + round((t - nearest_beat) / (beat / div)) * (beat / div)
            cand.append((float(snapped), float(s)))
        cand.sort()
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
    for i, (t, w) in enumerate(cand):
        lane = lane_for(at(times, cent, t), c_lo, c_hi, rng, prev_lane)
        dur = 0.0
        gap = (cand[i + 1][0] - t) if i + 1 < len(cand) else 0
        nxt_w = cand[i + 1][1] if i + 1 < len(cand) else 0
        if (level != "easy" and gap >= beat * 0.95 and w >= s_hi and nxt_w < s_mid
                and at(times, rms, t + gap * 0.6) >= loud * 0.8):
            # a strong hit followed by sustained sound and a weak next onset: hold it
            dur = round(min(gap + beat * 0.5, beat * 3), 3)
        notes.append([round(t, 3), lane, dur])
        # chords on strong hits: hard on the loudest 10 %, extreme on the loudest 30 %
        chord_pct = {"hard": 90, "extreme": 70}.get(level)
        if chord_pct is not None and w >= np.percentile(strength, chord_pct) and gap >= beat * (0.9 if level == "hard" else 0.45):
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
    args = p.parse_args()

    a = analyse(args.audio)
    rng = np.random.default_rng(args.seed)
    diffs = {}
    beat = 60 / a["tempo"]
    for level in ("easy", "normal", "hard", "extreme"):
        notes, beat = build(a, level, rng)
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
