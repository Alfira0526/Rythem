"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartSchema, DIFFICULTIES, DIFFICULTY_LABEL, toNotes, type Chart, type Difficulty, type Note } from "@/lib/chart";
import { Engine, type JudgeKind } from "@/lib/engine";
import { Renderer } from "@/lib/render";
import { SONGS } from "@/lib/songs";
import { getPlayerId, loadLocalBest, loadSettings, saveLocalBest, saveSettings, type Settings } from "@/lib/settings";
import { createPlayer, isVideoAdvancing, SyncClock, YT_STATE, type YTPlayer } from "@/lib/youtube";
import { fetchLeaderboard, submitScore, type Leaderboard, type SubmitResult } from "@/lib/api";

type Screen =
  | "home"
  | "tutorial"
  | "settings"
  | "ranking"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "result";

const KEY_LANES: Record<string, number> = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };

interface Outcome {
  score: number;
  accuracy: number;
  maxCombo: number;
  fullCombo: boolean;
  counts: Record<JudgeKind, number>;
  retired: boolean;
  retiredAt: number | null;
  avgOffsetMs: number | null;
}

export default function Game() {
  const [screen, setScreen] = useState<Screen>("home");
  const [songIdx, setSongIdx] = useState(0);
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [chart, setChart] = useState<Chart | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readyHint, setReadyHint] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [hud, setHud] = useState({ score: 0, life: 100, progress: 0 });
  const [localBest, setLocalBest] = useState<Record<string, number>>({});

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
  const pointerLanes = useRef(new Map<number, number>());
  const keyDown = useRef(new Set<string>());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  screenRef.current = screen;

  useEffect(() => {
    setLocalBest(loadLocalBest());
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
    setScreen("home");
  }, [destroyPlayer]);

  const finishRun = useCallback(
    (retired: boolean) => {
      const engine = engineRef.current;
      const clock = clockRef.current;
      if (!engine) return;
      cancelAnimationFrame(rafRef.current);
      clock?.stop();
      try {
        playerRef.current?.pauseVideo();
      } catch {
        /* ignore */
      }
      const out: Outcome = {
        score: engine.score,
        accuracy: engine.accuracy,
        maxCombo: engine.stats.maxCombo,
        fullCombo: !retired && engine.fullCombo,
        counts: { ...engine.stats.counts },
        retired,
        retiredAt: retired ? (clock?.now() ?? null) : null,
        avgOffsetMs: engine.averageOffsetMs(),
      };
      setOutcome(out);
      if (!retired && saveLocalBest(song.id, difficulty, out.score)) setLocalBest(loadLocalBest());
      setScreen("result");
    },
    [difficulty, song.id],
  );

  /* ---------------- loading: chart + player ---------------- */

  const startLoading = useCallback(async () => {
    setLoadError(null);
    setReadyHint(null);
    setOutcome(null);
    setScreen("loading");
    try {
      const res = await fetch(song.chartUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`chart ${res.status}`);
      const parsed = ChartSchema.parse(await res.json());
      setChart(parsed);
    } catch (e) {
      setLoadError(`채보를 불러오지 못했어요 (${(e as Error).message})`);
    }
  }, [song.chartUrl]);

  // Create the YouTube player once the chart is loaded and the host div exists.
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
      onError: (code) => setLoadError(`YouTube 플레이어 오류 (${code}). 이 영상은 임베드가 허용되지 않을 수 있어요.`),
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
    notesRef.current = toNotes(chart.difficulties[difficulty], chart.videoOffset);
    engineRef.current = new Engine(notesRef.current, {
      difficulty,
      inputOffset: settingsRef.current.offsetMs / 1000,
    });
    rendererRef.current = new Renderer(canvas);
    clockRef.current = new SyncClock(player);
    setHud({ score: 0, life: 100, progress: 0 });
    setReadyHint(null);
    try {
      player.seekTo(0, true);
      player.unMute();
      player.playVideo();
    } catch {
      /* ignore */
    }
    // wait until the video really advances (ads / buffering excluded)
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
      if (waited === 90) setReadyHint("영상의 ▶ 재생 버튼을 직접 눌러 주세요. 광고가 나오면 끝난 뒤 출발해요.");
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
      if (songTime > lastEnd + 1.5 || songTime >= chart.duration - 0.2) {
        finishRun(false);
        return;
      }
      if (++hudTick % 6 === 0) {
        setHud({ score: engine.score, life: engine.stats.life, progress: Math.min(1, songTime / chart.duration) });
      }
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
    const t = clock.now();
    renderer.pressLane(lane, performance.now() / 1000);
    const kind = engine.press(lane, t);
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

  useEffect(() => {
    if (screen !== "playing") return;
    const down = (e: KeyboardEvent) => {
      const lane = KEY_LANES[e.code];
      if (e.code === "Escape") {
        pauseGame();
        return;
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, pressLane, releaseLane]);

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

  function pauseGame() {
    if (screenRef.current !== "playing") return;
    cancelAnimationFrame(rafRef.current);
    try {
      playerRef.current?.pauseVideo();
    } catch {
      /* ignore */
    }
    // release any holds so they are not stuck
    for (const lane of pointerLanes.current.values()) releaseLane(lane);
    pointerLanes.current.clear();
    keyDown.current.clear();
    setScreen("paused");
  }

  const resumeGame = () => {
    setCountdown(3);
  };

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
          onStart={startLoading}
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
            saveSettings(s);
            setSettings(s);
            setScreen("home");
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
            <button className="btn btn-ghost px-2 py-1" onClick={screen === "playing" ? pauseGame : goHome} aria-label="pause">
              {screen === "playing" ? "❚❚" : "‹"}
            </button>
            <div className="flex-1">
              <div className="flex justify-between">
                <span className="muted">{song.title} · {DIFFICULTY_LABEL[difficulty]}</span>
                <span className="tabular-nums">{hud.score.toLocaleString("en-US")}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-white/10">
                <div
                  className="h-full rounded transition-[width] duration-150"
                  style={{ width: `${hud.life}%`, background: hud.life > 30 ? "var(--ok)" : "var(--bad)" }}
                />
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
                    <button className="btn mt-3" onClick={goHome}>돌아가기</button>
                  </div>
                ) : (
                  <span className="muted">MV와 채보를 불러오는 중…</span>
                )}
              </div>
            )}
            {screen === "ready" && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3 text-center text-xs">
                {readyHint ? <span className="text-[var(--warn)]">{readyHint}</span> : <span className="muted">광고가 나오면 끝난 뒤 자동으로 출발해요</span>}
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
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/60">
                <p className="text-sm muted">{DIFFICULTY_LABEL[difficulty]} · {notesCount(chart, difficulty)} notes</p>
                <button className="btn btn-primary px-10 py-4 text-lg" onClick={beginRace} disabled={!playerRef.current}>
                  눌러서 출발
                </button>
                <p className="text-xs muted">키보드: D F J K · 모바일: 레인 터치</p>
              </div>
            )}
            {screen === "paused" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75">
                {countdown !== null ? (
                  <span className="text-6xl font-black">{countdown}</span>
                ) : (
                  <>
                    <p className="text-lg font-bold">일시정지</p>
                    <button className="btn btn-primary w-48" onClick={resumeGame}>계속하기</button>
                    <button className="btn w-48" onClick={retry}>처음부터 다시</button>
                    <button className="btn btn-ghost w-48" onClick={goHome}>그만하기</button>
                  </>
                )}
              </div>
            )}
            {screen === "result" && outcome && (
              <ResultPanel
                outcome={outcome}
                songId={song.id}
                difficulty={difficulty}
                settings={settings}
                onNickname={(nick) => {
                  const s = { ...settings, nickname: nick };
                  saveSettings(s);
                  setSettings(s);
                }}
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

function notesCount(chart: Chart | null, d: Difficulty) {
  return chart ? chart.difficulties[d].length : 0;
}

/* ====================== screens ====================== */

function HomeScreen(props: {
  songIdx: number;
  setSongIdx: (i: number) => void;
  difficulty: Difficulty;
  setDifficulty: (d: Difficulty) => void;
  best?: number;
  onStart: () => void;
  onSettings: () => void;
  onRanking: () => void;
  onTutorial: () => void;
}) {
  const song = SONGS[props.songIdx];
  const many = SONGS.length > 1;
  return (
    <div className="flex min-h-dvh flex-col justify-center gap-6 px-5 py-8">
      <div className="text-center">
        <p className="text-[11px] font-extrabold tracking-[6px] muted">RHYTHM LANE</p>
      </div>
      <div className="card flex items-center justify-between p-4">
        <button className="btn btn-ghost" disabled={!many} onClick={() => props.setSongIdx((props.songIdx + SONGS.length - 1) % SONGS.length)}>‹</button>
        <div className="text-center">
          <p className="text-2xl font-black">{song.title}</p>
          <p className="text-sm muted">{song.artist}</p>
          {many && <p className="mt-1 text-xs muted">{SONGS.length}곡 중 {props.songIdx + 1}번째</p>}
        </div>
        <button className="btn btn-ghost" disabled={!many} onClick={() => props.setSongIdx((props.songIdx + 1) % SONGS.length)}>›</button>
      </div>
      <div>
        <p className="mb-2 text-sm muted">난이도 선택</p>
        <div className="grid grid-cols-3 gap-2">
          {DIFFICULTIES.map((d) => (
            <button
              key={d}
              className="btn"
              style={props.difficulty === d ? { borderColor: "var(--ink)", background: "var(--panel-2)" } : {}}
              onClick={() => props.setDifficulty(d)}
            >
              {DIFFICULTY_LABEL[d]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs muted">이 기기 최고 {props.best ? props.best.toLocaleString("en-US") : "—"}</p>
      </div>
      <button className="btn btn-primary py-4 text-lg" onClick={props.onStart}>레이스 시작</button>
      <div className="grid grid-cols-3 gap-2">
        <button className="btn" onClick={props.onSettings}>설정</button>
        <button className="btn" onClick={props.onTutorial}>도움말</button>
        <button className="btn" onClick={props.onRanking}>랭킹</button>
      </div>
      <p className="text-center text-[11px] muted">
        음악과 영상은 YouTube 공식 MV 임베드로 재생돼요. <a className="underline" href="/editor">채보 에디터</a>
      </p>
    </div>
  );
}

function TutorialScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col gap-4 px-5 py-8">
      <Header title="도움말" onBack={onBack} />
      <div className="card space-y-3 p-4 text-sm leading-relaxed">
        <p><b>탭</b> · 노트가 판정선에 닿을 때 해당 레인을 누르세요. 왼쪽 두 레인은 왼손, 오른쪽 두 레인은 오른손이 편해요.</p>
        <p><b>롱노트</b> · 막대가 끝날 때까지 손을 떼지 않아요. 너무 일찍 떼면 MISS예요.</p>
        <p><b>판정</b> · PERFECT 100 · GREAT 80 · GOOD 50 · MISS 0. 만점은 1,000,000점이에요.</p>
        <p><b>LIFE</b> · MISS마다 줄고 PERFECT마다 조금 회복돼요. 0이 되면 리타이어(DNF)예요.</p>
        <p><b>키보드</b> · D F J K가 왼쪽부터 4개 레인이에요. ESC로 일시정지.</p>
        <p><b>타이밍</b> · 소리보다 노트가 늦거나 빠르게 느껴지면 설정에서 입력 타이밍을 조절하세요. 결과 화면이 평균 오차를 알려줘요.</p>
        <p className="muted">영상은 YouTube에서 재생되므로 광고가 붙을 수 있어요. 광고가 끝나면 자동으로 출발해요.</p>
      </div>
    </div>
  );
}

function SettingsScreen({ settings, onSave, onBack }: { settings: Settings; onSave: (s: Settings) => void; onBack: () => void }) {
  const [s, setS] = useState(settings);
  return (
    <div className="flex min-h-dvh flex-col gap-4 px-5 py-8">
      <Header title="설정" onBack={onBack} />
      <label className="card block p-4">
        <div className="flex justify-between text-sm"><span>드라이버 이름</span><span className="muted">{s.nickname.length}/12</span></div>
        <input
          className="mt-2 w-full rounded-lg border border-[var(--line)] bg-black/30 px-3 py-2"
          value={s.nickname}
          maxLength={12}
          placeholder="랭킹에 표시될 이름"
          onChange={(e) => setS({ ...s, nickname: e.target.value })}
        />
      </label>
      <label className="card block p-4">
        <div className="flex justify-between text-sm"><span>노트 속도</span><span className="muted">{s.approach.toFixed(1)}s</span></div>
        <input type="range" min={0.5} max={3} step={0.1} value={s.approach} className="mt-2 w-full"
          onChange={(e) => setS({ ...s, approach: Number(e.target.value) })} />
        <p className="mt-1 text-xs muted">노트가 화면 위에서 판정선까지 내려오는 시간이에요. 짧을수록 빨라요.</p>
      </label>
      <label className="card block p-4">
        <div className="flex justify-between text-sm"><span>입력 타이밍</span><span className="muted">{s.offsetMs > 0 ? "+" : ""}{s.offsetMs}ms</span></div>
        <input type="range" min={-300} max={300} step={5} value={s.offsetMs} className="mt-2 w-full"
          onChange={(e) => setS({ ...s, offsetMs: Number(e.target.value) })} />
        <p className="mt-1 text-xs muted">결과 화면에서 "평균 Nms 늦게 눌렀어요"가 나오면 그 값만큼 + 쪽으로 옮기세요.</p>
      </label>
      <label className="card flex items-center justify-between p-4 text-sm">
        <span>진동</span>
        <input type="checkbox" checked={s.vibrate} onChange={(e) => setS({ ...s, vibrate: e.target.checked })} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <button className="btn" onClick={() => setS({ ...s, approach: 1.3, offsetMs: 0, vibrate: true })}>기본값으로</button>
        <button className="btn btn-primary" onClick={() => onSave({ ...s, nickname: s.nickname.trim() })}>저장</button>
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
      <Header title="랭킹" onBack={onBack} />
      <div className="grid grid-cols-3 gap-2">
        {DIFFICULTIES.map((d) => (
          <button key={d} className="btn" style={difficulty === d ? { borderColor: "var(--ink)" } : {}} onClick={() => setDifficulty(d)}>
            {DIFFICULTY_LABEL[d]}
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-[var(--bad)]">랭킹 서버에 연결하지 못했어요 ({error})</p>}
      {!data && !error && <p className="text-sm muted">기록을 불러오는 중…</p>}
      {data && (
        <div className="card overflow-hidden">
          {data.storage === "memory" && <p className="bg-[var(--warn)]/10 px-3 py-2 text-xs text-[var(--warn)]">DATABASE_URL이 없어 서버 메모리에만 저장 중이에요 (재시작 시 초기화).</p>}
          {data.me && <p className="px-3 py-2 text-xs muted">내 순위 {data.me.rank}위 · {data.me.score.toLocaleString("en-US")}</p>}
          {data.rows.length === 0 && <p className="px-3 py-6 text-center text-sm muted">아직 등록된 기록이 없어요.</p>}
          {data.rows.map((r) => (
            <div key={r.playerId} className="flex items-center gap-3 border-t border-[var(--line)] px-3 py-2 text-sm"
              style={r.playerId === playerId ? { background: "rgba(53,224,255,0.08)" } : {}}>
              <span className="w-7 text-right font-bold tabular-nums">{r.rank}</span>
              <span className="flex-1 truncate">{r.nickname}{r.fullCombo && <span className="ml-1 text-[10px] text-[var(--ok)]">FC</span>}</span>
              <span className="tabular-nums">{r.score.toLocaleString("en-US")}</span>
              <span className="w-14 text-right text-xs muted tabular-nums">{r.accuracy.toFixed(2)}%</span>
            </div>
          ))}
        </div>
      )}
      <p className="text-center text-xs muted">상위 50위까지</p>
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

  const offsetHint =
    o.avgOffsetMs !== null && Math.abs(o.avgOffsetMs) >= 15
      ? `평균 ${Math.abs(o.avgOffsetMs)}ms ${o.avgOffsetMs > 0 ? "늦게" : "빠르게"} 눌렀어요. 설정의 입력 타이밍을 ${o.avgOffsetMs > 0 ? "+" : "-"} 쪽으로 옮기면 맞아요.`
      : null;

  return (
    <div className="absolute inset-0 overflow-y-auto bg-[var(--bg)]/95 p-4">
      <p className="text-center text-xs font-extrabold tracking-[4px] muted">{o.retired ? "RETIRED · DNF" : "FINISH"}</p>
      <p className="mt-1 text-center text-4xl font-black tabular-nums">{o.score.toLocaleString("en-US")}</p>
      <p className="text-center text-sm muted">
        정확도 {o.accuracy.toFixed(2)}% · 최대 콤보 {o.maxCombo}
        {o.fullCombo && <span className="ml-2 font-bold text-[var(--ok)]">{o.counts.great + o.counts.good === 0 ? "ALL PERFECT" : "FULL COMBO"}</span>}
      </p>
      <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
        {(["perfect", "great", "good", "miss"] as JudgeKind[]).map((k) => (
          <div key={k} className="card p-2">
            <p className="muted">{k.toUpperCase()}</p>
            <p className="text-lg font-bold tabular-nums">{o.counts[k]}</p>
          </div>
        ))}
      </div>
      {offsetHint && <p className="mt-3 text-xs text-[var(--warn)]">{offsetHint}</p>}

      <div className="card mt-3 p-3 text-sm">
        {o.retired ? (
          <p className="muted">완주해야 랭킹에 기록을 등록할 수 있어요. LIFE를 지키며 다시 도전해 보세요.</p>
        ) : state === "done" && result ? (
          <p>
            {result.improved ? "랭킹에 등록했어요." : "기존 기록이 더 높아서 그대로 두었어요."}
            {result.rank && <span className="muted"> 현재 {result.rank}위 · 최고 {result.best.toLocaleString("en-US")}</span>}
            {result.storage === "memory" && <span className="block text-xs text-[var(--warn)]">서버가 메모리 저장 모드예요. 재배포 시 초기화돼요.</span>}
          </p>
        ) : (
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-black/30 px-3 py-2"
              placeholder="드라이버 이름"
              maxLength={12}
              value={nick}
              onChange={(e) => setNick(e.target.value)}
            />
            <button className="btn btn-primary" disabled={!nick.trim() || state === "submitting"} onClick={submit}>
              {state === "submitting" ? "등록 중…" : state === "failed" ? "다시 등록" : "랭킹 등록"}
            </button>
          </div>
        )}
        {state === "failed" && <p className="mt-2 text-xs text-[var(--bad)]">등록에 실패했어요 ({err}). 이 기록은 이 기기에만 저장돼요.</p>}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <button className="btn" onClick={props.onRetry}>다시 도전</button>
        <button className="btn" onClick={props.onRanking}>랭킹 보기</button>
        <button className="btn" onClick={props.onHome}>곡 선택</button>
      </div>
    </div>
  );
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <button className="btn btn-ghost px-2" onClick={onBack} aria-label="back">‹</button>
      <h2 className="text-lg font-bold">{title}</h2>
    </div>
  );
}
