#!/usr/bin/env python3
"""Check (and optionally fix) a chart for two-thumb playability.

Assumption: left thumb covers lanes 0-1, right thumb covers lanes 2-3.

    python3 tools/check_chart.py public/charts/*.json          # report
    python3 tools/check_chart.py public/charts/*.json --fix    # rewrite in place

Rules (per difficulty):
  R1  never more than 2 notes at the same time
  R2  a 2-note chord must use one lane per hand
  R3  while a hold is held, the other hand only: no note on the held hand's lanes, no chords
  R4  two consecutive notes on the same hand need at least MIN_SAME_HAND[level] seconds
  R5  any two consecutive notes need at least MIN_ANY[level] seconds
Fixes: extra chord notes are dropped, same-hand chords/hold conflicts are mirrored to the
other hand, too-fast same-hand notes are mirrored when the other hand is free, else dropped.
"""
import argparse, json, sys

MIN_SAME_HAND = {"easy": 0.30, "normal": 0.22, "hard": 0.16, "extreme": 0.11}
MIN_ANY = {"easy": 0.25, "normal": 0.18, "hard": 0.10, "extreme": 0.085}
EPS = 0.002

def hand(lane): return 0 if lane < 2 else 1
def mirror(lane): return 3 - lane

def check(notes, level, fix=False):
    """notes: list of [t, lane, dur]. Returns (fixed_notes, issues:list[str], stats)."""
    notes = sorted([list(n) for n in notes], key=lambda n: (n[0], n[1]))
    issues = []
    out = []
    last_hit = {0: -9.0, 1: -9.0}        # last press time per hand
    hold_until = {0: -9.0, 1: -9.0}      # hand busy with a hold until this time
    last_any = -9.0
    i = 0
    while i < len(notes):
        t = notes[i][0]
        group = [notes[i]]
        j = i + 1
        while j < len(notes) and abs(notes[j][0] - t) < EPS:
            group.append(notes[j]); j += 1
        i = j
        # R1: at most two
        if len(group) > 2:
            issues.append(f"R1 {t:.3f}s {len(group)} simultaneous notes")
            if fix:
                group.sort(key=lambda n: -n[2])  # keep holds first
                keep = [group[0]]
                for n in group[1:]:
                    if hand(n[1]) != hand(keep[0][1]):
                        keep.append(n); break
                group = keep
        # R2: chord must split hands
        if len(group) == 2 and hand(group[0][1]) == hand(group[1][1]):
            issues.append(f"R2 {t:.3f}s chord on one hand (lanes {group[0][1]},{group[1][1]})")
            if fix:
                group[1][1] = mirror(group[1][1])
        # R3: holds in progress
        busy = [h for h in (0, 1) if hold_until[h] > t + EPS]
        if busy:
            if len(group) == 2:
                issues.append(f"R3 {t:.3f}s chord during a hold")
                if fix:
                    group = [n for n in group if hand(n[1]) not in busy][:1] or group[:1]
            for n in group:
                if hand(n[1]) in busy:
                    issues.append(f"R3 {t:.3f}s note on lane {n[1]} while that hand holds")
                    if fix:
                        n[1] = mirror(n[1])
                        if hand(n[1]) in busy:  # both hands busy: drop
                            group = [g for g in group if g is not n]
        # R4/R5: speed
        if fix and len(group) == 1:
            n = group[0]
            h = hand(n[1])
            if t - last_hit[h] < MIN_SAME_HAND[level] - EPS and t - last_hit[1 - h] >= MIN_SAME_HAND[level] - EPS and hold_until[1 - h] <= t + EPS:
                n[1] = mirror(n[1])
        for n in group:
            h = hand(n[1])
            if t - last_hit[h] < MIN_SAME_HAND[level] - EPS:
                issues.append(f"R4 {t:.3f}s same-hand gap {t - last_hit[h]:.3f}s on lane {n[1]}")
                if fix:
                    group = [g for g in group if g is not n]
                    continue
        if group and t - last_any < MIN_ANY[level] - EPS:
            issues.append(f"R5 {t:.3f}s gap {t - last_any:.3f}s")
            if fix:
                group = []
        for n in group:
            h = hand(n[1])
            last_hit[h] = t
            if n[2] > 0:
                hold_until[h] = t + n[2]
        if group:
            last_any = t
        out.extend(group)
    out.sort(key=lambda n: (n[0], n[1]))
    return out, issues

def main():
    p = argparse.ArgumentParser()
    p.add_argument("charts", nargs="+")
    p.add_argument("--fix", action="store_true")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()
    total_issues = 0
    for path in args.charts:
        chart = json.load(open(path, encoding="utf-8"))
        print(f"== {chart['id']}  (bpm {chart['bpm']}, videoOffset {chart['videoOffset']})")
        for level, notes in chart["difficulties"].items():
            fixed, issues = check(notes, level, fix=args.fix)
            # after a fix pass, re-check to report what remains
            remaining = check(fixed, level, fix=False)[1] if args.fix else issues
            kinds = {}
            for s in issues:
                kinds[s[:2]] = kinds.get(s[:2], 0) + 1
            summary = ", ".join(f"{k}×{v}" for k, v in sorted(kinds.items())) or "clean"
            tail = f" -> {len(fixed)} notes, remaining {len(remaining)}" if args.fix else ""
            print(f"   {level:<8} {len(notes):>4} notes  issues {len(issues):>3} [{summary}]{tail}")
            if args.verbose:
                for s in issues[:15]: print("      ", s)
            total_issues += len(issues)
            if args.fix:
                chart["difficulties"][level] = fixed
        if args.fix:
            json.dump(chart, open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    return 0 if total_issues == 0 or args.fix else 1

if __name__ == "__main__":
    sys.exit(main())
