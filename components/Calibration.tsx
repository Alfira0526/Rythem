"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Note } from "@/lib/chart";
import { Engine, median } from "@/lib/engine";
import { Renderer } from "@/lib/render";
import { approachFor, type Settings } from "@/lib/settings";
import { DIFFICULTY_RULE } from "@/lib/difficulty";
import { S } from "@/lib/strings";

/* Timing calibration without any song: 16 click notes at 120 BPM from the
 * Web Audio clock. Notes 1–4 are practice, notes 5–16 are measured. */

const PRACTICE = 4;
const MEASURED = 12;
const TOTAL = PRACTICE + MEASURED;
const INTERVAL = 0.5; // sec (120 BPM)
const LEAD_IN = 1.6; // sec before the first note
const CAPTURE = 0.25; // sec; wider than normal play so a large offset still registers
const LANES = [1, 2, 1, 2, 0, 1, 2, 3, 2, 1, 0, 3, 1, 2, 1, 2];
const KEY_LANES: Record<string, number> = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };

export interface CalibrationResult {
  samples: number;
  medianMs: number | null;
  spreadMs: number;
  fromMs: number;
  toMs: number;
}

function buildNotes(): Note[] {
  return LANES.map((lane, index) => {
    const time = LEAD_IN + index * INTERVAL;
    return { index, time, lane, duration: 0, end: time };
  });
}

export default function Calibration({
  settings,
  onApply,
  onCancel,
}: {
  settings: Settings;
  onApply: (offsetMs: number) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "noAudio">("idle");
  const [hits, setHits] = useState(0);
  const [result, setResult] = useState<CalibrationResult | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const notesRef = useRef<Note[]>([]);
  const ctxRef = useRef<AudioContext | null>(null);
  const t0Ref = useRef(0);
  const rafRef = useRef(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const pointerLanes = useRef(new Map<number, number>());
  const keyDown = useRef(new Set<string>());

  const songTime = useCallback(() => {
    const ctx = ctxRef.current;
    return ctx ? ctx.currentTime - t0Ref.current : 0;
  }, []);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    try {
      void ctxRef.current?.close();
    } catch {
      /* ignore */
    }
    ctxRef.current = null;
  }, []);

  const finish = useCallback(() => {
    const engine = engineRef.current;
    stop();
    if (!engine) return;
    const offs = engine.events
      .filter((e) => e.noteIndex >= PRACTICE && !e.tail && e.offset !== null && e.kind !== "miss")
      .map((e) => e.offset as number);
    const fromMs = Math.round(engine.inputOffset * 1000);
    const med = offs.length >= 6 ? median(offs) : null;
    const sorted = [...offs].sort((a, b) => a - b);
    const spread = sorted.length >= 4 ? sorted[Math.floor(sorted.length * 0.75)] - sorted[Math.floor(sorted.length * 0.25)] : 0;
    setResult({
      samples: offs.length,
      medianMs: med === null ? null : Math.round(med * 1000),
      spreadMs: Math.round(spread * 1000),
      fromMs,
      toMs: med === null ? fromMs : Math.max(-400, Math.min(400, Math.round(fromMs - med * 1000))),
    });
    setPhase("done");
  }, [stop]);

  const start = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) {
      setPhase("noAudio");
      return;
    }
    const ctx = new AC();
    void ctx.resume();
    ctxRef.current = ctx;
    const notes = buildNotes();
    notesRef.current = notes;
    engineRef.current = new Engine(notes, {
      difficulty: "normal",
      inputOffset: settings.offsetMs / 1000,
      captureWindow: CAPTURE,
      immortal: true,
    });
    rendererRef.current = new Renderer(canvas);
    t0Ref.current = ctx.currentTime + 0.1;
    // schedule the clicks: lower tone for the practice notes, higher for the measured ones
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = n.index < PRACTICE ? 660 : 880;
      const at = t0Ref.current + n.time;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.5, at + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.06);
    }
    setHits(0);
    setResult(null);
    setPhase("running");
  }, [settings.offsetMs]);

  // game loop
  useEffect(() => {
    if (phase !== "running") return;
    const engine = engineRef.current;
    const renderer = rendererRef.current;
    if (!engine || !renderer) return;
    const notes = notesRef.current;
    const lastTime = notes[notes.length - 1].time;
    const approach = approachFor(settings.speedLevel) * DIFFICULTY_RULE.normal.approachScale;
    const onResize = () => renderer.resize();
    window.addEventListener("resize", onResize);
    renderer.resize();
    let tick = 0;
    const loop = () => {
      if (phaseRef.current !== "running") return;
      const t = songTime();
      engine.update(t);
      renderer.draw(engine, notes, t, { approach }, performance.now() / 1000);
      if (++tick % 6 === 0) setHits(engine.stats.judged);
      if (t > lastTime + CAPTURE + 0.3) {
        finish();
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
    };
  }, [phase, settings.speedLevel, songTime, finish]);

  const press = useCallback(
    (lane: number) => {
      const engine = engineRef.current;
      const renderer = rendererRef.current;
      if (!engine || !renderer || phaseRef.current !== "running") return;
      renderer.pressLane(lane, performance.now() / 1000);
      const kind = engine.press(lane, songTime());
      if (kind && settings.vibrate && "vibrate" in navigator) {
        try {
          navigator.vibrate(8);
        } catch {
          /* ignore */
        }
      }
    },
    [songTime, settings.vibrate],
  );

  useEffect(() => {
    if (phase !== "running") return;
    const down = (e: KeyboardEvent) => {
      const lane = KEY_LANES[e.code];
      if (lane === undefined || keyDown.current.has(e.code)) return;
      keyDown.current.add(e.code);
      e.preventDefault();
      press(lane);
    };
    const up = (e: KeyboardEvent) => keyDown.current.delete(e.code);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [phase, press]);

  useEffect(() => () => stop(), [stop]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    e.preventDefault();
    const lane = renderer.laneAt(e.clientX);
    pointerLanes.current.set(e.pointerId, lane);
    press(lane);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const lane = pointerLanes.current.get(e.pointerId);
    pointerLanes.current.delete(e.pointerId);
    if (lane !== undefined) engineRef.current?.release(lane, songTime());
  };

  const progress =
    hits < PRACTICE ? S.calibrationPractice(hits) : S.calibrationMeasure(Math.min(MEASURED, hits - PRACTICE));

  return (
    <div className="flex h-dvh flex-col no-select">
      <div className="flex items-center gap-3 px-3 py-2 text-xs font-bold">
        <button className="btn btn-ghost px-2 py-1" onClick={() => { stop(); onCancel(); }} aria-label={S.back}>‹</button>
        <span className="muted flex-1">{S.calibrating}</span>
        <span className="tabular-nums">{phase === "running" ? progress : ""}</span>
      </div>
      <div className="relative flex-1">
        <canvas
          ref={canvasRef}
          className="block h-full w-full touch-none"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        />
        {phase === "idle" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[var(--bg)]/70 px-6 text-center">
            <p className="text-sm muted">{S.calibrationGuide}</p>
            <button className="btn btn-primary px-10 py-4 text-lg" onClick={start}>{S.calibrationTap}</button>
            <p className="text-xs muted">{S.controlsHint}</p>
          </div>
        )}
        {phase === "noAudio" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[var(--bg)]/90 px-6 text-center">
            <p className="text-sm text-[var(--bad)]">{S.calibrationNoAudio}</p>
            <button className="btn" onClick={onCancel}>{S.back}</button>
          </div>
        )}
        {phase === "done" && result && (
          <CalibrationPanel
            result={result}
            onApply={() => onApply(result.toMs)}
            onRetry={() => setPhase("idle")}
            onCancel={onCancel}
          />
        )}
      </div>
    </div>
  );
}

function CalibrationPanel({ result: r, onApply, onRetry, onCancel }: {
  result: CalibrationResult;
  onApply: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const ok = r.medianMs !== null;
  return (
    <div className="absolute inset-0 overflow-y-auto bg-[var(--bg)]/95 p-4">
      <p className="text-center text-xs font-extrabold tracking-[4px]" style={{ color: "var(--serenity)" }}>{S.calibrationResult}</p>
      {ok ? (
        <>
          <p className="mt-2 text-center text-3xl font-black tabular-nums">{r.medianMs! > 0 ? "+" : ""}{r.medianMs}ms</p>
          <p className="text-center text-sm muted">{S.calibrationMeasured(r.medianMs!, r.samples)}</p>
          <p className="mt-3 text-center text-sm">{S.calibrationChange(r.fromMs, r.toMs)}</p>
          {r.spreadMs > 120 && <p className="mt-2 text-center text-xs text-[var(--warn)]">{S.calibrationNoisy}</p>}
        </>
      ) : (
        <p className="mt-3 text-center text-sm text-[var(--warn)]">{S.calibrationTooFew}</p>
      )}
      <div className="mt-5 grid grid-cols-3 gap-2">
        <button className="btn btn-primary" disabled={!ok} onClick={onApply}>{S.apply}</button>
        <button className="btn btn-secondary" onClick={onRetry}>{S.measureAgain}</button>
        <button className="btn" onClick={onCancel}>{S.cancel}</button>
      </div>
    </div>
  );
}
