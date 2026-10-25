"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartSchema, DIFFICULTIES, DIFFICULTY_LABEL, UNLOCK_REQUIREMENT, toNotes, type Chart, type Difficulty, type Note } from "@/lib/chart";
import { Engine, median, type JudgeKind } from "@/lib/engine";
import { Renderer } from "@/lib/render";
import { SONGS } from "@/lib/songs";
import { getPlayerId, loadLocalBest, loadSettings, loadUnlocks, saveLocalBest, saveSettings, saveUnlock, type Settings, type Unlocks } from "@/lib/settings";
import { createPlayer, isVideoAdvancing, SyncClock, YT_STATE, type YTPlayer } from "@/lib/youtube";
import { fetchLeaderboard, submitScore, type Leaderboard, type SubmitResult } from "@/lib/api";
import { S } from "@/lib/strings";

type Screen = "home" | "tutorial" | "settings" | "ranking" | "loading" | "ready" | "playing" | "paused" | "result";
type Mode = "play" | "calibrate";

/** a calibration run matches presses this far from a note (sec) */
const CALIBRATION_CAPTURE = 0.3;

const KEY_LANES: Record<string, number> = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };

interface Outcome {
  score: number;
  accuracy: number;
  maxCombo: number;
  fullCombo: boolean;
  counts: Record<JudgeKind, number>;
  retired: boolean;
  avgOffsetMs: number | null;
  /** difficulty newly unlocked by this run, if any */
  unlocked: Difficulty | null;
}

interface CalibrationOutcome {
  samples: number;
  medianMs: number | null;
  spreadMs: number;
  fromMs: number;
  toMs: number;
}

export default function Game() {
  const [screen, setScreen] = useState<Screen>("home");
  const [mode, setMode] = useState<Mode>("play");
  const [songIdx, setSongIdx] = useState(0);
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [chart, setChart] = useState<Chart | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readyHint, setReadyHint] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [calibration, setCalibration] = useState<CalibrationOutcome | null>(null);
  const [hud, setHud] = useState({ score: 0, life: 100, hits: 0 });
  const [localBest, setLocalBest] = useState<Record<string, number>>({});
  const [unlocks, setUnlocks] = useState<Unlocks>({});

  const song = SONGS[songIdx];

  const ytHostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const clockRef = useRef<SyncClock | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const notesRef = useRef<Note[]>([]);
  const rafRef = useRef(0);
  const screenRef = useRef<Screen>("home");
  const modeRef = useRef<Mode>("play");
  const pointerLanes = useRef(new Map<number, number>());
  const keyDown = useRef(new Set<string>());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  screenRef.current = screen;
  modeRef.current = mode;
  const runDifficulty: Difficulty = mode === "calibrate" ? "easy" : difficulty;

  useEffect(() => {
    setLocalBest(loadLocalBest());
    setUnlocks(loadUnlocks());
  }, []);

  const persistSettings = useCallback((s: Settings) => {
    saveSettings(s);
    setSettings(s);
  }, []);

  /* ---------------- lifecycle helpers ---------------- */

  const destroyPlayer = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    clockRef.current?.stop();
    try {
      playerRef.current?.destroy();
    } catch {
      /* ignore */
    }
    playerRef.current = null;
    clockRef.current = null;
    engineRef.current = null;
    rendererRef.current = null;
  }, []);

  const goHome = useCallback(() => {
    destroyPlayer();
    setChart(null);
    setOutcome(null);
    setCalibration(null);
    setMode("play");
    setScreen("home");
  }, [destroyPlayer]);

  const finishRun = useCallback(
    (retired: boolean) => {
      const engine = engineRef.current;
      if (!engine) return;
      cancelAnimationFrame(rafRef.current);
      clockRef.current?.stop();
      try {
        playerRef.current?.pauseVideo();
      } catch {
        /* ignore */
      }
      if (modeRef.current === "calibrate") {
        const offs = engine.hitOffsets;
        const fromMs = Math.round(engine.inputOffset * 1000);
        const med = offs.length >= 4 ? median(offs) : null;
        const sorted = [...offs].sort((a, b) => a - b);
        const spread = sorted.length >= 4 ? sorted[Math.floor(sorted.length * 0.75)] - sorted[Math.floor(sorted.length * 0.25)] : 0;
        setCalibration({
          samples: offs.length,
          medianMs: med === null ? null : Math.round(med * 1000),
          spreadMs: Math.round(spread * 1000),
          fromMs,
          toMs: med === null ? fromMs : Math.max(-400, Math.min(400, Math.round(fromMs - med * 1000))),
        });
        setScreen("result");
        return;
      }
      const fullCombo = !retired && engine.fullCombo;
      let unlocked: Difficulty | null = null;
      if (fullCombo) {
        for (const d of DIFFICULTIES) {
          if (UNLOCK_REQUIREMENT[d] === difficulty && saveUnlock(song.id, d)) unlocked = d;
        }
        if (unlocked) setUnlocks(loadUnlocks());
      }
      const out: Outcome = {
        score: engine.score,
        accuracy: engine.accuracy,
        maxCombo: engine.stats.maxCombo,
        fullCombo,
        counts: { ...engine.stats.counts },
        retired,
        avgOffsetMs: engine.averageOffsetMs(),
        unlocked,
      };
      setOutcome(out);
      if (!retired && saveLocalBest(song.id, difficulty, out.score)) setLocalBest(loadLocalBest());
      setScreen("result");
    },
    [difficulty, song.id],
  );

  /* ---------------- loading: chart + player ---------------- */

  const startLoading = useCallback(async (nextMode: Mode = "play") => {
    setMode(nextMode);
    modeRef.current = nextMode;
    setLoadError(null);
    setReadyHint(null);
    setOutcome(null);
    setCalibration(null);
    setScreen("loading");
    try {
      const res = await fetch(song.chartUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`chart ${res.status}`);
      setChart(ChartSchema.parse(await res.json()));
    } catch (e) {
      setLoadError(S.chartLoadFail((e as Error).message));
    }
  }, [song.chartUrl]);

  useEffect(() => {
    if (screen !== "loading" || !chart || !ytHostRef.current || playerRef.current) return;
    let cancelled = false;
    const host = ytHostRef.current;
    host.innerHTML = "";
    const target = document.createElement("div");
    host.appendChild(target);
    createPlayer({
      el: target,
      videoId: chart.videoId,
      onStateChange: (state) => {
        if (state === YT_STATE.ENDED && screenRef.current === "playing") finishRun(false);
      },
      onError: (code) => setLoadError(S.ytError(code)),
    })
      .then((player) => {
        if (cancelled) {
          player.destroy();
          return;
        }
        playerRef.current = player;
        setScreen("ready");
      })
      .catch((e: Error) => setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [screen, chart, finishRun]);

  /* ---------------- ready → playing ---------------- */

  const beginRace = useCallback(() => {
    const player = playerRef.current;
    const canvas = canvasRef.current;
    if (!player || !chart || !canvas) return;
    const s = settingsRef.current;
    const calibrating = modeRef.current === "calibrate";
    const d: Difficulty = calibrating ? "easy" : difficulty;
    notesRef.current = toNotes(chart.difficulties[d], chart.videoOffset + s.visualOffsetMs / 1000);
    engineRef.current = new Engine(notesRef.current, {
      difficulty: d,
      inputOffset: s.offsetMs / 1000,
      captureWindow: calibrating ? CALIBRATION_CAPTURE : undefined,
      immortal: calibrating,
    });
    rendererRef.current = new Renderer(canvas);
    clockRef.current = new SyncClock(player);
    setHud({ score: 0, life: 100, hits: 0 });
    setReadyHint(null);
    try {
      player.seekTo(0, true);
      player.unMute();
      player.playVideo();
    } catch {
      /* ignore */
    }
    let prev = -1;
    let waited = 0;
    const tick = () => {
      const p = playerRef.current;
      if (!p || screenRef.current !== "ready") return;
      if (isVideoAdvancing(p, chart.duration, prev)) {
        clockRef.current?.start();
        setScreen("playing");
        return;
      }
      try {
        prev = p.getCurrentTime();
      } catch {
        prev = -1;
      }
      waited += 1;
      if (waited === 90) setReadyHint(S.readyHint);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [chart, difficulty]);

  /* ---------------- game loop ---------------- */

  useEffect(() => {
    if (screen !== "playing") return;
    const engine = engineRef.current;
    const renderer = rendererRef.current;
    const clock = clockRef.current;
    const player = playerRef.current;
    if (!engine || !renderer || !clock || !player || !chart) return;
    const notes = notesRef.current;
    const lastEnd = notes.length ? notes[notes.length - 1].end : 0;
    let hudTick = 0;
    const onResize = () => renderer.resize();
    window.addEventListener("resize", onResize);
    renderer.resize();

    const loop = () => {
      if (screenRef.current !== "playing") return;
      const songTime = clock.now();
      const wall = performance.now() / 1000;
      engine.update(songTime);
      renderer.draw(engine, notes, songTime, { approach: settingsRef.current.approach }, wall);
      if (engine.retired) {
        finishRun(true);
        return;
      }
      const calibrating = modeRef.current === "calibrate";
      if (calibrating && engine.hitOffsets.length >= settingsRef.current.calibrationNotes) {
        finishRun(false);
        return;
      }
      if (songTime > lastEnd + 1.5 || songTime >= chart.duration - 0.2) {
        finishRun(false);
        return;
      }
      if (++hudTick % 6 === 0) setHud({ score: engine.score, life: engine.stats.life, hits: engine.hitOffsets.length });
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
    };
  }, [screen, chart, finishRun]);

  /* ---------------- input ---------------- */

  const pressLane = useCallback((lane: number) => {
    const engine = engineRef.current;
    const clock = clockRef.current;
    const renderer = rendererRef.current;
    if (!engine || !clock || !renderer || screenRef.current !== "playing") return;
    renderer.pressLane(lane, performance.now() / 1000);
    const kind = engine.press(lane, clock.now());
    if (kind && settingsRef.current.vibrate && "vibrate" in navigator) {
      try {
        navigator.vibrate(kind === "perfect" ? 12 : 8);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const releaseLane = useCallback((lane: number) => {
    const engine = engineRef.current;
    const clock = clockRef.current;
    if (!engine || !clock || screenRef.current !== "playing") return;
    engine.release(lane, clock.now());
  }, []);

  const pauseGame = useCallback(() => {
    if (screenRef.current !== "playing") return;
    cancelAnimationFrame(rafRef.current);
    try {
      playerRef.current?.pauseVideo();
    } catch {
      /* ignore */
    }
    for (const lane of pointerLanes.current.values()) releaseLane(lane);
    pointerLanes.current.clear();
    keyDown.current.clear();
    setScreen("paused");
  }, [releaseLane]);

  useEffect(() => {
    if (screen !== "playing") return;
    const down = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        pauseGame();
        return;
      }
      const lane = KEY_LANES[e.code];
      if (lane === undefined || keyDown.current.has(e.code)) return;
      keyDown.current.add(e.code);
      e.preventDefault();
      pressLane(lane);
    };
    const up = (e: KeyboardEvent) => {
      const lane = KEY_LANES[e.code];
      if (lane === undefined) return;
      keyDown.current.delete(e.code);
      releaseLane(lane);
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") pauseGame();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [screen, pressLane, releaseLane, pauseGame]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    e.preventDefault();
    const lane = renderer.laneAt(e.clientX);
    pointerLanes.current.set(e.pointerId, lane);
    pressLane(lane);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const lane = pointerLanes.current.get(e.pointerId);
    pointerLanes.current.delete(e.pointerId);
    if (lane !== undefined) releaseLane(lane);
  };

  /* ---------------- pause / resume ---------------- */

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      setCountdown(null);
      try {
        playerRef.current?.playVideo();
      } catch {
        /* ignore */
      }
      clockRef.current?.start();
      setScreen("playing");
      return;
    }
    const t = window.setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => window.clearTimeout(t);
  }, [countdown]);

  const retry = () => {
    cancelAnimationFrame(rafRef.current);
    setOutcome(null);
    setScreen("ready");
  };

  useEffect(() => () => destroyPlayer(), [destroyPlayer]);

  /* ---------------- render ---------------- */

  const bestKey = `${song.id}:${difficulty}`;
  const inPlayLayout = ["loading", "ready", "playing", "paused", "result"].includes(screen);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col">
      {screen === "home" && (
        <HomeScreen
          songIdx={songIdx}
          setSongIdx={setSongIdx}
          difficulty={difficulty}
          setDifficulty={setDifficulty}
          best={localBest[bestKey]}
          unlocks={unlocks}
          onStart={() => void startLoading("play")}
          onSettings={() => setScreen("settings")}
          onRanking={() => setScreen("ranking")}
          onTutorial={() => setScreen("tutorial")}
        />
      )}

      {screen === "tutorial" && <TutorialScreen onBack={() => setScreen("home")} />}

      {screen === "settings" && (
        <SettingsScreen
          settings={settings}
          onSave={(s) => {
            persistSettings(s);
            setScreen("home");
          }}
          onCalibrate={(s) => {
            persistSettings(s);
            void startLoading("calibrate");
          }}
          onBack={() => setScreen("home")}
        />
      )}

      {screen === "ranking" && (
        <RankingScreen songId={song.id} initialDifficulty={difficulty} onBack={() => setScreen("home")} />
      )}

      {inPlayLayout && (
        <div className="flex h-dvh flex-col no-select">
          {/* HUD */}
          <div className="flex items-center gap-3 px-3 py-2 text-xs font-bold">
            <button className="btn btn-ghost px-2 py-1" onClick={screen === "playing" ? pauseGame : goHome} aria-label={screen === "playing" ? S.paused : S.back}>
              {screen === "playing" ? "❚❚" : "‹"}
            </button>
            <div className="flex-1">
              <div className="flex justify-between">
                <span className="muted">
                  {mode === "calibrate" ? S.calibrating : `${song.title} · ${DIFFICULTY_LABEL[runDifficulty]}`}
                </span>
                <span className="tabular-nums">
                  {mode === "calibrate" ? S.calibrationProgress(hud.hits, settings.calibrationNotes) : hud.score.toLocaleString("en-US")}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-[10px] muted">HP</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded bg-white/10">
                  <div
                    className="h-full rounded transition-[width] duration-150"
                    style={{
                      width: `${hud.life}%`,
                      background: hud.life > 30 ? "linear-gradient(90deg, var(--serenity), var(--rose))" : "var(--bad)",
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* video */}
          <div className="relative w-full bg-black" style={{ aspectRatio: "16 / 9" }}>
            <div ref={ytHostRef} className="absolute inset-0 [&>div]:h-full [&>div]:w-full [&_iframe]:h-full [&_iframe]:w-full" />
            {screen === "loading" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-sm">
                {loadError ? (
                  <div className="px-4 text-center">
                    <p className="text-[var(--bad)]">{loadError}</p>
                    <button className="btn mt-3" onClick={goHome}>{S.back}</button>
                  </div>
                ) : (
                  <span className="muted">{S.loading}</span>
                )}
              </div>
            )}
            {screen === "ready" && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3 text-center text-xs">
                {readyHint ? <span className="text-[var(--warn)]">{readyHint}</span> : <span className="muted">{S.readyNote}</span>}
              </div>
            )}
          </div>

          {/* lanes */}
          <div className="relative flex-1">
            <canvas
              ref={canvasRef}
              className="block h-full w-full touch-none"
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onContextMenu={(e) => e.preventDefault()}
            />
            {screen === "ready" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[var(--bg)]/70">
                <p className="text-sm muted">
                  {mode === "calibrate"
                    ? S.calibrationGuide
                    : `${DIFFICULTY_LABEL[runDifficulty]} · ${S.notes(chart ? chart.difficulties[runDifficulty].length : 0)}`}
                </p>
                <button className="btn btn-primary px-10 py-4 text-lg" onClick={beginRace} disabled={!playerRef.current}>
                  {S.tapToStart}
                </button>
                <p className="text-xs muted">{S.controlsHint}</p>
              </div>
            )}
            {screen === "paused" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--bg)]/85">
                {countdown !== null ? (
                  <span className="text-6xl font-black">{countdown}</span>
                ) : (
                  <>
                    <p className="text-lg font-bold">{S.paused}</p>
                    <button className="btn btn-primary w-48" onClick={() => setCountdown(3)}>{S.resume}</button>
                    <button className="btn w-48" onClick={retry}>{S.restart}</button>
                    <button className="btn btn-ghost w-48" onClick={goHome}>{S.quit}</button>
                  </>
                )}
              </div>
            )}
            {screen === "result" && mode === "calibrate" && calibration && (
              <CalibrationPanel
                result={calibration}
                onApply={() => {
                  persistSettings({ ...settingsRef.current, offsetMs: calibration.toMs });
                  destroyPlayer();
                  setChart(null);
                  setMode("play");
                  setScreen("settings");
                }}
                onRetry={retry}
                onCancel={() => {
                  destroyPlayer();
                  setChart(null);
                  setMode("play");
                  setScreen("settings");
                }}
              />
            )}
            {screen === "result" && mode === "play" && outcome && (
              <ResultPanel
                outcome={outcome}
                songId={song.id}
                difficulty={difficulty}
                settings={settings}
                onNickname={(nick) => persistSettings({ ...settings, nickname: nick })}
                onRetry={retry}
                onRanking={() => {
                  destroyPlayer();
                  setChart(null);
                  setScreen("ranking");
                }}
                onHome={goHome}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ====================== screens ====================== */

function HomeScreen(props: {
  songIdx: number;
  setSongIdx: (i: number) => void;
  difficulty: Difficulty;
  setDifficulty: (d: Difficulty) => void;
  best?: number;
  unlocks: Unlocks;
  onStart: () => void;
  onSettings: () => void;
  onRanking: () => void;
  onTutorial: () => void;
}) {
  const song = SONGS[props.songIdx];
  const many = SONGS.length > 1;
  const isLocked = (d: Difficulty) => !!UNLOCK_REQUIREMENT[d] && !props.unlocks[`${song.id}:${d}`];
  const lockedSel = isLocked(props.difficulty);
  const req = UNLOCK_REQUIREMENT[props.difficulty];
  return (
    <div className="flex min-h-dvh flex-col justify-center gap-6 px-5 py-8">
      <p className="text-center text-[11px] font-extrabold tracking-[6px]" style={{ color: "var(--serenity)" }}>{S.appName}</p>
      <div className="card flex items-center justify-between p-4" style={{ borderColor: "var(--serenity-deep)" }}>
        <button className="btn btn-ghost" disabled={!many} onClick={() => props.setSongIdx((props.songIdx + SONGS.length - 1) % SONGS.length)}>‹</button>
        <div className="text-center">
          <p className="text-2xl font-black">{song.title}</p>
          <p className="text-sm muted">{song.artist}</p>
          {many && <p className="mt-1 text-xs muted">{S.songCount(props.songIdx + 1, SONGS.length)}</p>}
        </div>
        <button className="btn btn-ghost" disabled={!many} onClick={() => props.setSongIdx((props.songIdx + 1) % SONGS.length)}>›</button>
      </div>
      <div>
        <p className="mb-2 text-sm muted">{S.difficulty}</p>
        <div className="grid grid-cols-4 gap-2">
          {DIFFICULTIES.map((d) => {
            const locked = isLocked(d);
            return (
              <button
                key={d}
                className={`btn px-1 text-sm ${props.difficulty === d ? "btn-selected" : ""}`}
                style={locked ? { borderStyle: "dashed", color: "var(--muted)" } : {}}
                onClick={() => props.setDifficulty(d)}
                aria-label={locked ? `${DIFFICULTY_LABEL[d]} (${S.locked})` : DIFFICULTY_LABEL[d]}
              >
                {locked ? "🔒 " : ""}{DIFFICULTY_LABEL[d]}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs muted">
          {lockedSel && req
            ? S.lockedHint(DIFFICULTY_LABEL[req], DIFFICULTY_LABEL[props.difficulty])
            : `${S.bestOnDevice} ${props.best ? props.best.toLocaleString("en-US") : "—"}`}
        </p>
      </div>
      <button className="btn btn-primary py-4 text-lg" onClick={props.onStart} disabled={lockedSel}>
        {lockedSel ? S.locked : S.play}
      </button>
      <div className="grid grid-cols-3 gap-2">
        <button className="btn" onClick={props.onSettings}>{S.settings}</button>
        <button className="btn" onClick={props.onTutorial}>{S.howTo}</button>
        <button className="btn" onClick={props.onRanking}>{S.leaderboard}</button>
      </div>
      <p className="text-center text-[11px] muted">
        {S.footer} <a className="underline" href="/editor">{S.editorLink}</a>
      </p>
    </div>
  );
}

function TutorialScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col gap-4 px-5 py-8">
      <Header title={S.tutorialTitle} onBack={onBack} />
      <div className="card space-y-3 p-4 text-sm leading-relaxed">
        {S.tutorial.map(([head, body]) => (
          <p key={head}><b style={{ color: "var(--rose)" }}>{head}</b> · {body}</p>
        ))}
        <p className="muted">{S.tutorialNote}</p>
      </div>
    </div>
  );
}

function SettingsScreen({
  settings,
  onSave,
  onCalibrate,
  onBack,
}: {
  settings: Settings;
  onSave: (s: Settings) => void;
  onCalibrate: (s: Settings) => void;
  onBack: () => void;
}) {
  const [s, setS] = useState(settings);
  const sign = (n: number) => `${n > 0 ? "+" : ""}${n}ms`;
  const clean = (x: Settings): Settings => ({ ...x, nickname: x.nickname.trim() });
  return (
    <div className="flex min-h-dvh flex-col gap-4 px-5 py-8">
      <Header title={S.settings} onBack={onBack} />
      <label className="card block p-4">
        <div className="flex justify-between text-sm"><span>{S.nickname}</span><span className="muted">{s.nickname.length}/12</span></div>
        <input className="field mt-2" value={s.nickname} maxLength={12} placeholder={S.nicknamePlaceholder}
          onChange={(e) => setS({ ...s, nickname: e.target.value })} />
        <p className="mt-1 text-xs muted">{S.nicknameHelp}</p>
      </label>
      <label className="card block p-4">
        <div className="flex justify-between text-sm"><span>{S.approach}</span><span className="muted">{s.approach.toFixed(1)}s</span></div>
        <input type="range" min={0.5} max={3} step={0.1} value={s.approach} className="mt-2 w-full"
          onChange={(e) => setS({ ...s, approach: Number(e.target.value) })} />
        <p className="mt-1 text-xs muted">{S.approachHelp}</p>
      </label>
      <label className="card block p-4">
        <div className="flex justify-between text-sm"><span>{S.inputOffset}</span><span className="muted">{sign(s.offsetMs)}</span></div>
        <input type="range" min={-400} max={400} step={5} value={s.offsetMs} className="mt-2 w-full"
          onChange={(e) => setS({ ...s, offsetMs: Number(e.target.value) })} />
        <p className="mt-1 text-xs muted">{S.inputOffsetHelp}</p>
      </label>
      <div className="card block p-4">
        <p className="text-sm font-bold" style={{ color: "var(--rose)" }}>{S.calibration}</p>
        <label className="mt-2 flex items-center justify-between text-sm">
          <span>{S.calibrationNotes}</span>
          <input
            type="number"
            inputMode="numeric"
            min={8}
            max={64}
            step={1}
            value={s.calibrationNotes}
            className="field w-24 text-right"
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) setS({ ...s, calibrationNotes: Math.max(8, Math.min(64, Math.round(v))) });
            }}
          />
        </label>
        <p className="mt-1 text-xs muted">{S.calibrationHelp}</p>
        <button className="btn btn-secondary mt-3 w-full" onClick={() => onCalibrate(clean(s))}>{S.calibrationStart}</button>
      </div>
      <label className="card block p-4">
        <div className="flex justify-between text-sm"><span>{S.visualOffset}</span><span className="muted">{sign(s.visualOffsetMs)}</span></div>
        <input type="range" min={-500} max={500} step={10} value={s.visualOffsetMs} className="mt-2 w-full"
          onChange={(e) => setS({ ...s, visualOffsetMs: Number(e.target.value) })} />
        <p className="mt-1 text-xs muted">{S.visualOffsetHelp}</p>
      </label>
      <label className="card flex items-start justify-between gap-3 p-4 text-sm">
        <span>
          {S.vibrate}
          <span className="mt-1 block text-xs muted">{S.vibrateHelp}</span>
        </span>
        <input type="checkbox" checked={s.vibrate} onChange={(e) => setS({ ...s, vibrate: e.target.checked })} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <button className="btn" onClick={() => setS({ ...s, approach: 1.3, offsetMs: 0, visualOffsetMs: 0, calibrationNotes: 16, vibrate: true })}>{S.reset}</button>
        <button className="btn btn-primary" onClick={() => onSave(clean(s))}>{S.save}</button>
      </div>
    </div>
  );
}

function RankingScreen({ songId, initialDifficulty, onBack }: { songId: string; initialDifficulty: Difficulty; onBack: () => void }) {
  const [difficulty, setDifficulty] = useState<Difficulty>(initialDifficulty);
  const [data, setData] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playerId = useMemo(() => getPlayerId(), []);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    fetchLeaderboard(songId, difficulty, playerId).then((r) => {
      if (!alive) return;
      if (r.ok) setData(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [songId, difficulty, playerId]);
  return (
    <div className="flex min-h-dvh flex-col gap-4 px-5 py-8">
      <Header title={S.leaderboard} onBack={onBack} />
      <div className="grid grid-cols-4 gap-2">
        {DIFFICULTIES.map((d) => (
          <button key={d} className={`btn px-1 text-sm ${difficulty === d ? "btn-selected" : ""}`} onClick={() => setDifficulty(d)}>
            {DIFFICULTY_LABEL[d]}
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-[var(--bad)]">{S.serverFail(error)}</p>}
      {!data && !error && <p className="text-sm muted">{S.loadingRecords}</p>}
      {data && (
        <div className="card overflow-hidden">
          {data.storage === "memory" && <p className="px-3 py-2 text-xs text-[var(--warn)]">{S.memoryWarning}</p>}
          {data.me && <p className="px-3 py-2 text-xs muted">{S.myRank(data.me.rank, data.me.score)}</p>}
          {data.rows.length === 0 && <p className="px-3 py-6 text-center text-sm muted">{S.noRecords}</p>}
          {data.rows.map((r) => (
            <div key={r.playerId} className="flex items-center gap-3 border-t border-[var(--line)] px-3 py-2 text-sm"
              style={r.playerId === playerId ? { background: "rgba(247,202,201,0.12)" } : {}}>
              <span className="w-7 text-right font-bold tabular-nums" style={r.rank <= 3 ? { color: "var(--rose)" } : {}}>{r.rank}</span>
              <span className="flex-1 truncate">{r.nickname}{r.fullCombo && <span className="ml-1 text-[10px]" style={{ color: "var(--serenity)" }}>FC</span>}</span>
              <span className="tabular-nums">{r.score.toLocaleString("en-US")}</span>
              <span className="w-14 text-right text-xs muted tabular-nums">{r.accuracy.toFixed(2)}%</span>
            </div>
          ))}
        </div>
      )}
      <p className="text-center text-xs muted">{S.top50}</p>
    </div>
  );
}

function ResultPanel(props: {
  outcome: Outcome;
  songId: string;
  difficulty: Difficulty;
  settings: Settings;
  onNickname: (nick: string) => void;
  onRetry: () => void;
  onRanking: () => void;
  onHome: () => void;
}) {
  const { outcome: o } = props;
  const [nick, setNick] = useState(props.settings.nickname);
  const [state, setState] = useState<"idle" | "submitting" | "done" | "failed">("idle");
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const name = nick.trim();
    if (!name) return;
    props.onNickname(name);
    setState("submitting");
    const r = await submitScore({
      songId: props.songId,
      difficulty: props.difficulty,
      playerId: getPlayerId(),
      nickname: name,
      score: o.score,
      accuracy: o.accuracy,
      maxCombo: o.maxCombo,
      fullCombo: o.fullCombo,
      counts: o.counts,
    });
    if (r.ok) {
      setResult(r.data);
      setState("done");
    } else {
      setErr(r.error);
      setState("failed");
    }
  };

  const hints: string[] = [];
  if (o.avgOffsetMs !== null && Math.abs(o.avgOffsetMs) >= 15)
    hints.push(`${o.avgOffsetMs > 0 ? S.offsetLate(o.avgOffsetMs) : S.offsetEarly(-o.avgOffsetMs)} ${S.offsetTip}`);

  return (
    <div className="absolute inset-0 overflow-y-auto bg-[var(--bg)]/95 p-4">
      <p className="text-center text-xs font-extrabold tracking-[4px]" style={{ color: o.retired ? "var(--bad)" : "var(--serenity)" }}>
        {o.retired ? S.gameOver : S.clear}
      </p>
      <p className="mt-1 text-center text-4xl font-black tabular-nums">{o.score.toLocaleString("en-US")}</p>
      <p className="text-center text-sm muted">
        {S.accuracy} {o.accuracy.toFixed(2)}% · {S.maxCombo} {o.maxCombo}
        {o.fullCombo && <span className="ml-2 font-bold" style={{ color: "var(--rose)" }}>{o.counts.great + o.counts.good === 0 ? S.allPerfect : S.fullCombo}</span>}
      </p>
      <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
        {(["perfect", "great", "good", "miss"] as JudgeKind[]).map((k) => (
          <div key={k} className="card p-2">
            <p className="muted">{k.toUpperCase()}</p>
            <p className="text-lg font-bold tabular-nums">{o.counts[k]}</p>
          </div>
        ))}
      </div>
      {o.unlocked && (
        <p className="mt-3 rounded-xl border px-3 py-2 text-center text-sm font-bold" style={{ borderColor: "var(--rose)", color: "var(--rose)" }}>
          {S.unlocked(DIFFICULTY_LABEL[o.unlocked])}
        </p>
      )}
      {hints.map((h) => <p key={h} className="mt-3 text-xs text-[var(--warn)]">{h}</p>)}

      <div className="card mt-3 p-3 text-sm">
        {o.retired ? (
          <p className="muted">{S.mustClear}</p>
        ) : state === "done" && result ? (
          <p>
            {result.improved ? S.submitted : S.notImproved}
            {result.rank && <span className="muted"> {S.currentRank(result.rank, result.best)}</span>}
            {result.storage === "memory" && <span className="block text-xs text-[var(--warn)]">{S.memoryWarning}</span>}
          </p>
        ) : (
          <div className="flex gap-2">
            <input className="field min-w-0 flex-1" placeholder={S.nickname} maxLength={12} value={nick} onChange={(e) => setNick(e.target.value)} />
            <button className="btn btn-primary" disabled={!nick.trim() || state === "submitting"} onClick={submit}>
              {state === "submitting" ? S.submitting : state === "failed" ? S.submitRetry : S.submit}
            </button>
          </div>
        )}
        {state === "failed" && (
          <p className="mt-2 text-xs text-[var(--bad)]">{err === "extreme_locked" ? S.extremeLocked : S.submitFailed(err ?? "")}</p>
        )}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <button className="btn btn-secondary" onClick={props.onRetry}>{S.retry}</button>
        <button className="btn" onClick={props.onRanking}>{S.viewLeaderboard}</button>
        <button className="btn" onClick={props.onHome}>{S.toHome}</button>
      </div>
    </div>
  );
}

function CalibrationPanel({ result: r, onApply, onRetry, onCancel }: {
  result: CalibrationOutcome;
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

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <button className="btn btn-ghost px-2" onClick={onBack} aria-label={S.back}>‹</button>
      <h2 className="text-lg font-bold">{title}</h2>
    </div>
  );
}
