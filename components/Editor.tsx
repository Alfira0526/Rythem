"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartSchema, DIFFICULTIES, DIFFICULTY_LABEL, type Chart, type Difficulty, type NoteTuple } from "@/lib/chart";
import { SONGS } from "@/lib/songs";
import { createPlayer, SyncClock, YT_STATE, type YTPlayer } from "@/lib/youtube";

/* A small timeline editor: notes scroll upward as the video plays. Click an
 * empty cell to add a note on the beat grid, click a note to delete it. Tap
 * SPACE on the beat while the video plays to measure the video offset. */

const LANES = 4;
const PX_PER_SEC = 160;
const WINDOW_SEC = 4; // visible time span

export default function Editor() {
  const [chart, setChart] = useState<Chart | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [snap, setSnap] = useState(2); // grid divisions per beat
  const [holdBeats, setHoldBeats] = useState(0);
  const [status, setStatus] = useState("채보를 불러오는 중…");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [taps, setTaps] = useState<number[]>([]);
  const [dirty, setDirty] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const clockRef = useRef<SyncClock | null>(null);
  const timeRef = useRef(0);
  const rafRef = useRef(0);

  const [songIdx, setSongIdx] = useState(() => {
    if (typeof window === "undefined") return 0;
    const id = new URLSearchParams(window.location.search).get("song");
    const i = SONGS.findIndex((x) => x.id === id);
    return i >= 0 ? i : 0;
  });
  const song = SONGS[songIdx];

  // load chart (local draft first, then the published file)
  useEffect(() => {
    setChart(null);
    setTaps([]);
    setDirty(false);
    const draft = localStorage.getItem(`rhythm-lane.draft.${song.id}`);
    if (draft) {
      try {
        setChart(ChartSchema.parse(JSON.parse(draft)));
        setStatus("브라우저에 저장된 초안을 불러왔어요.");
        return;
      } catch {
        /* fall through */
      }
    }
    fetch(song.chartUrl, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        setChart(ChartSchema.parse(j));
        setStatus("채보를 불러왔어요.");
      })
      .catch((e) => setStatus(`불러오기 실패: ${e.message}`));
  }, [song.chartUrl, song.id]);

  // player (recreated when the song changes)
  const chartVideoId = chart?.videoId ?? null;
  useEffect(() => {
    if (!chartVideoId || !hostRef.current) return;
    const host = hostRef.current;
    host.innerHTML = "";
    const target = document.createElement("div");
    host.appendChild(target);
    let cancelled = false;
    createPlayer({
      el: target,
      videoId: chartVideoId,
      onStateChange: (s) => setPlaying(s === YT_STATE.PLAYING),
    }).then((p) => {
      if (cancelled) {
        p.destroy();
        return;
      }
      playerRef.current = p;
      clockRef.current = new SyncClock(p);
      clockRef.current.start();
    });
    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      clockRef.current = null;
    };
  }, [chartVideoId]);

  const beat = chart ? 60 / chart.bpm : 0.5;
  const notes = useMemo(() => (chart ? chart.difficulties[difficulty] : []), [chart, difficulty]);

  const updateNotes = useCallback(
    (next: NoteTuple[]) => {
      if (!chart) return;
      next.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const c = { ...chart, difficulties: { ...chart.difficulties, [difficulty]: next } };
      setChart(c);
      setDirty(true);
      localStorage.setItem(`rhythm-lane.draft.${song.id}`, JSON.stringify(c));
    },
    [chart, difficulty, song.id],
  );

  const snapTime = useCallback(
    (t: number) => {
      if (!chart) return t;
      const step = beat / snap;
      return Math.round((t - chart.offset) / step) * step + chart.offset;
    },
    [chart, beat, snap],
  );

  // draw loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !chart) return;
    const ctx = canvas.getContext("2d")!;
    const draw = () => {
      const clock = clockRef.current;
      const p = playerRef.current;
      let t = timeRef.current;
      if (clock && p) {
        try {
          t = p.getPlayerState() === YT_STATE.PLAYING ? clock.now() : p.getCurrentTime();
        } catch {
          /* ignore */
        }
      }
      timeRef.current = t;
      setTime((prev) => (Math.abs(prev - t) > 0.03 ? t : prev));

      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(rect.width * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = rect.width, H = rect.height;
      const hitY = H * 0.8;
      const yFor = (tt: number) => hitY - (tt - t) * PX_PER_SEC;
      const lw = W / LANES;
      ctx.fillStyle = "#121726";
      ctx.fillRect(0, 0, W, H);
      // beat grid
      const tStart = t - (H - hitY) / PX_PER_SEC;
      const tEnd = t + hitY / PX_PER_SEC;
      const step = beat / snap;
      const k0 = Math.floor((tStart - chart.offset) / step);
      const k1 = Math.ceil((tEnd - chart.offset) / step);
      for (let k = k0; k <= k1; k++) {
        const tt = chart.offset + k * step;
        const y = yFor(tt);
        const onBeat = k % snap === 0;
        ctx.strokeStyle = onBeat ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.08)";
        ctx.lineWidth = onBeat ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        if (onBeat && (k / snap) % 4 === 0) {
          ctx.fillStyle = "rgba(255,255,255,0.5)";
          ctx.font = "11px ui-monospace, monospace";
          ctx.fillText(tt.toFixed(2), 4, y - 3);
        }
      }
      for (let l = 1; l < LANES; l++) {
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.beginPath();
        ctx.moveTo(l * lw, 0);
        ctx.lineTo(l * lw, H);
        ctx.stroke();
      }
      // notes
      for (const [nt, lane, dur] of notes) {
        const shifted = nt + chart.videoOffset;
        if (shifted + dur < tStart - 0.5 || shifted > tEnd + 0.5) continue;
        const y = yFor(shifted);
        const x = lane * lw + lw * 0.12;
        const w = lw * 0.76;
        if (dur > 0) {
          ctx.fillStyle = "rgba(146,168,209,0.35)";
          ctx.fillRect(x + w * 0.3, yFor(shifted + dur), w * 0.4, dur * PX_PER_SEC);
        }
        ctx.fillStyle = lane === 0 || lane === 3 ? "#92a8d1" : "#f7cac9";
        ctx.fillRect(x, y - 7, w, 14);
      }
      // hit line
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, hitY);
      ctx.lineTo(W, hitY);
      ctx.stroke();
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [chart, notes, beat, snap]);

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!chart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const lane = Math.max(0, Math.min(3, Math.floor((x / rect.width) * LANES)));
    const hitY = rect.height * 0.8;
    const tClick = timeRef.current + (hitY - y) / PX_PER_SEC - chart.videoOffset;
    // delete if a note is near
    const idx = notes.findIndex(([nt, l]) => l === lane && Math.abs(nt - tClick) < 0.09);
    if (idx >= 0) {
      updateNotes(notes.filter((_, i) => i !== idx));
      return;
    }
    const t = Math.max(0, snapTime(tClick));
    updateNotes([...notes, [Number(t.toFixed(3)), lane, Number((holdBeats * beat).toFixed(3))]]);
  };

  // keyboard: space = tap for offset measurement, arrows = seek
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const p = playerRef.current;
      if (!p || !chart) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (p.getPlayerState() === YT_STATE.PLAYING) {
          const t = clockRef.current?.now() ?? p.getCurrentTime();
          setTaps((prev) => [...prev.slice(-31), t]);
        } else p.playVideo();
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        e.preventDefault();
        const d = (e.code === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 1);
        p.seekTo(Math.max(0, p.getCurrentTime() + d), true);
      } else if (e.code === "KeyP") {
        if (p.getPlayerState() === YT_STATE.PLAYING) p.pauseVideo();
        else p.playVideo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chart]);

  // measured offset: how far taps land from the nearest chart beat
  const tapOffsetMs = useMemo(() => {
    if (!chart || taps.length < 8) return null;
    const errs = taps.map((t) => {
      const rel = (t - chart.videoOffset - chart.offset) / beat;
      return (rel - Math.round(rel)) * beat;
    });
    errs.sort((a, b) => a - b);
    return Math.round(errs[Math.floor(errs.length / 2)] * 1000);
  }, [taps, chart, beat]);

  const setVideoOffset = (v: number) => {
    if (!chart) return;
    const c = { ...chart, videoOffset: Number(v.toFixed(3)) };
    setChart(c);
    setDirty(true);
    localStorage.setItem(`rhythm-lane.draft.${song.id}`, JSON.stringify(c));
  };

  /** Set videoOffset so the chart's first note lands on the current video time. */
  const alignFirstNote = () => {
    if (!chart) return;
    const all = Object.values(chart.difficulties).flat();
    if (!all.length) return;
    const first = Math.min(...all.map((n) => n[0]));
    const now = (() => {
      try {
        return clockRef.current?.now() ?? playerRef.current?.getCurrentTime() ?? timeRef.current;
      } catch {
        return timeRef.current;
      }
    })();
    setVideoOffset(now - first);
  };

  const download = () => {
    if (!chart) return;
    const blob = new Blob([JSON.stringify(chart)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${chart.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setDirty(false);
  };

  const discardDraft = () => {
    localStorage.removeItem(`rhythm-lane.draft.${song.id}`);
    location.reload();
  };

  if (!chart) return <div className="p-6 text-sm">{status}</div>;

  return (
    <div className="mx-auto grid min-h-dvh max-w-[1100px] grid-cols-1 gap-3 p-3 md:grid-cols-[360px_1fr]">
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-bold">채보 편집기</h1>
          <select className="field w-auto" value={songIdx} onChange={(e) => setSongIdx(Number(e.target.value))}>
            {SONGS.map((x, i) => <option key={x.id} value={i}>{x.title} · {x.artist}</option>)}
          </select>
        </div>
        <div className="relative w-full bg-black" style={{ aspectRatio: "16 / 9" }}>
          <div ref={hostRef} className="absolute inset-0 [&>div]:h-full [&>div]:w-full [&_iframe]:h-full [&_iframe]:w-full" />
        </div>
        <div className="card space-y-2 p-3">
          <div className="flex items-center justify-between">
            <span className="tabular-nums">{time.toFixed(2)}s {playing ? "▶" : "❚❚"}</span>
            <div className="flex gap-1">
              <button className="btn px-2 py-1" onClick={() => playerRef.current?.seekTo(Math.max(0, timeRef.current - 5), true)}>-5s</button>
              <button className="btn px-2 py-1" onClick={() => (playing ? playerRef.current?.pauseVideo() : playerRef.current?.playVideo())}>{playing ? "일시정지" : "재생"}</button>
              <button className="btn px-2 py-1" onClick={() => playerRef.current?.seekTo(timeRef.current + 5, true)}>+5s</button>
            </div>
          </div>
          <input type="range" min={0} max={chart.duration} step={0.01} value={time} className="w-full"
            onChange={(e) => { playerRef.current?.seekTo(Number(e.target.value), true); timeRef.current = Number(e.target.value); }} />
          <p className="text-xs muted">P 재생/정지 · ←/→ 1초 (Shift 5초) · Space 박자 탭</p>
        </div>
        <div className="card space-y-2 p-3">
          <div className="grid grid-cols-3 gap-1">
            {DIFFICULTIES.map((d) => (
              <button key={d} className={`btn px-2 py-1 ${difficulty === d ? "btn-selected" : ""}`} onClick={() => setDifficulty(d)}>
                {DIFFICULTY_LABEL[d]} <span className="muted">{chart.difficulties[d].length}</span>
              </button>
            ))}
          </div>
          <label className="flex items-center justify-between">그리드
            <select className="rounded bg-black/30 px-2 py-1" value={snap} onChange={(e) => setSnap(Number(e.target.value))}>
              <option value={1}>1/4 (비트)</option><option value={2}>1/8</option><option value={3}>1/12</option><option value={4}>1/16</option>
            </select>
          </label>
          <label className="flex items-center justify-between">추가 시 롱노트 길이
            <select className="rounded bg-black/30 px-2 py-1" value={holdBeats} onChange={(e) => setHoldBeats(Number(e.target.value))}>
              <option value={0}>탭</option><option value={0.5}>½ 비트</option><option value={1}>1 비트</option><option value={2}>2 비트</option>
            </select>
          </label>
          <p className="text-xs muted">빈 칸 클릭 = 노트 추가 · 노트 클릭 = 삭제. 변경은 브라우저에 자동 저장돼요.</p>
        </div>
        <div className="card space-y-2 p-3">
          <div className="flex items-center justify-between">
            <span>영상 오프셋</span>
            <span className="tabular-nums">{(chart.videoOffset * 1000).toFixed(0)}ms</span>
          </div>
          <div className="flex gap-1">
            {[-1000, -50, -10, 10, 50, 1000].map((d) => (
              <button key={d} className="btn flex-1 px-1 py-1 text-xs" onClick={() => setVideoOffset(chart.videoOffset + d / 1000)}>{d > 0 ? "+" : ""}{d}</button>
            ))}
          </div>
          <button className="btn btn-secondary w-full py-2 text-sm" onClick={alignFirstNote}>첫 노트 맞추기 (지금 이 순간 = 첫 노트)</button>
          <p className="text-xs muted">
            MV에 인트로가 있어 음원과 시작점이 다르면: 영상을 재생하다가 첫 노트가 들리는 순간 위 버튼을 누르세요. 그 뒤 Space 탭으로 미세 조정해요.
            {chart.audioDuration && Math.abs(chart.duration - chart.audioDuration) > 1 && (
              <> 이 곡은 영상({chart.duration.toFixed(0)}s)과 음원({chart.audioDuration.toFixed(0)}s) 길이가 달라요.</>
            )}
          </p>
          <p className="text-xs muted">
            영상을 재생하며 박자에 맞춰 Space를 8번 이상 누르면 오차를 측정해요.
            {tapOffsetMs !== null && (
              <>
                {" "}측정값 <b>{tapOffsetMs > 0 ? "+" : ""}{tapOffsetMs}ms</b> ({taps.length}탭){" "}
                <button className="underline" onClick={() => setVideoOffset(chart.videoOffset + tapOffsetMs / 1000)}>적용</button>
                {" · "}
                <button className="underline" onClick={() => setTaps([])}>초기화</button>
              </>
            )}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button className="btn btn-primary" onClick={download}>JSON 내려받기{dirty ? " *" : ""}</button>
          <button className="btn" onClick={discardDraft}>초안 버리기</button>
        </div>
        <p className="text-xs muted">내려받은 파일을 <code>public/charts/{chart.id}.json</code>에 덮어쓰고 배포하면 게임에 반영돼요. <a className="underline" href="/">게임으로</a></p>
      </div>
      <canvas ref={canvasRef} className="h-[70vh] w-full cursor-crosshair rounded-xl md:h-auto" onClick={onCanvasClick} />
    </div>
  );
}
