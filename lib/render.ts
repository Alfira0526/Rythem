import type { Note } from "./chart";
import type { Engine, JudgeKind } from "./engine";

const LANES = 4;
const LANE_COLORS = ["#35e0ff", "#ff3df0", "#ff3df0", "#35e0ff"];
const JUDGE_COLOR: Record<JudgeKind, string> = {
  perfect: "#ffffff",
  great: "#37f08a",
  good: "#ffd23f",
  miss: "#ff4d4d",
};
const JUDGE_LABEL: Record<JudgeKind, string> = {
  perfect: "PERFECT",
  great: "GREAT",
  good: "GOOD",
  miss: "MISS",
};

export interface RenderOptions {
  approach: number; // seconds from top to hit line
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private sparks: Spark[] = [];
  private banner: { text: string; color: string; at: number } | null = null;
  private pressedAt = new Array<number>(LANES).fill(-Infinity);
  private lastFrame = 0;
  private eventsSeen = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.ctx = ctx;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
  }

  get laneWidth() {
    return this.width / LANES;
  }

  get hitY() {
    return this.height - Math.max(64, this.height * 0.16);
  }

  laneAt(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.max(0, Math.min(LANES - 1, Math.floor((x / rect.width) * LANES)));
  }

  pressLane(lane: number, now: number) {
    this.pressedAt[lane] = now;
  }

  private yFor(time: number, songTime: number, approach: number): number {
    const dt = time - songTime;
    return this.hitY - (dt / approach) * this.hitY;
  }

  private spawnSparks(lane: number, color: string, count: number) {
    const x = (lane + 0.5) * this.laneWidth;
    const y = this.hitY;
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
      const sp = 180 + Math.random() * 260;
      this.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.45, color });
    }
  }

  draw(engine: Engine, notes: Note[], songTime: number, opts: RenderOptions, wall: number) {
    const { ctx, width, height, dpr } = this;
    const dt = Math.min(0.05, this.lastFrame ? wall - this.lastFrame : 0.016);
    this.lastFrame = wall;

    // react to new judgement events
    while (this.eventsSeen < engine.events.length) {
      const ev = engine.events[this.eventsSeen++];
      this.banner = { text: JUDGE_LABEL[ev.kind], color: JUDGE_COLOR[ev.kind], at: wall };
      if (ev.kind !== "miss") this.spawnSparks(ev.lane, JUDGE_COLOR[ev.kind], ev.kind === "perfect" ? 14 : 7);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // background
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, "#07080c");
    g.addColorStop(1, "#111422");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    const lw = this.laneWidth;
    const hitY = this.hitY;

    // lane backgrounds and press glow
    for (let l = 0; l < LANES; l++) {
      const x = l * lw;
      const since = wall - this.pressedAt[l];
      if (since < 0.18) {
        const a = (1 - since / 0.18) * 0.35;
        const lg = ctx.createLinearGradient(0, hitY, 0, 0);
        lg.addColorStop(0, `rgba(255,255,255,${a})`);
        lg.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = lg;
        ctx.fillRect(x, 0, lw, hitY);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    }

    // hit line
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, hitY);
    ctx.lineTo(width, hitY);
    ctx.stroke();
    for (let l = 0; l < LANES; l++) {
      ctx.strokeStyle = LANE_COLORS[l];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse((l + 0.5) * lw, hitY, lw * 0.34, 10, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // notes
    const noteH = Math.max(14, lw * 0.22);
    const pad = lw * 0.12;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const st = engine.states[i];
      if (st.done && !(st.holding)) continue;
      if (n.time - songTime > opts.approach + 0.2) break;
      if (st.head === "miss") continue;
      const yHead = this.yFor(n.time, songTime, opts.approach);
      const x = n.lane * lw + pad;
      const w = lw - pad * 2;
      const color = LANE_COLORS[n.lane];
      if (n.duration > 0) {
        const yTail = this.yFor(n.end, songTime, opts.approach);
        const top = Math.max(-20, yTail);
        const bottom = st.holding ? hitY : yHead;
        ctx.fillStyle = st.holding ? "rgba(255,255,255,0.55)" : hexA(color, 0.35);
        roundRect(ctx, x + w * 0.25, top, w * 0.5, Math.max(0, bottom - top), 6);
        ctx.fill();
        if (!st.holding && st.head === null && yHead > -noteH) {
          drawNote(ctx, x, yHead - noteH / 2, w, noteH, color);
        }
      } else if (yHead > -noteH) {
        drawNote(ctx, x, yHead - noteH / 2, w, noteH, color);
      }
    }

    // sparks
    this.sparks = this.sparks.filter((s) => (s.life -= dt) > 0);
    for (const s of this.sparks) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 700 * dt;
      ctx.fillStyle = hexA(s.color, s.life / 0.45);
      ctx.fillRect(s.x - 2, s.y - 2, 4, 4);
    }

    // banner
    if (this.banner && wall - this.banner.at < 0.5) {
      const age = wall - this.banner.at;
      const scale = 1 + Math.max(0, 0.25 - age) * 1.2;
      ctx.save();
      ctx.translate(width / 2, hitY - height * 0.22);
      ctx.scale(scale, scale);
      ctx.font = `900 ${Math.round(Math.min(40, lw * 0.5))}px ui-sans-serif, system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = this.banner.color;
      ctx.globalAlpha = 1 - age / 0.5;
      ctx.fillText(this.banner.text, 0, 0);
      ctx.restore();
    }

    // combo
    if (engine.stats.combo >= 2) {
      ctx.font = `800 ${Math.round(Math.min(56, lw * 0.7))}px ui-sans-serif, system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText(String(engine.stats.combo), width / 2, hitY - height * 0.36);
      ctx.font = `700 12px ui-sans-serif, system-ui`;
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillText("COMBO", width / 2, hitY - height * 0.36 + Math.min(56, lw * 0.7) * 0.7);
    }
  }
}

function drawNote(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  roundRect(ctx, x + 4, y + 3, w - 8, Math.max(2, h * 0.28), 3);
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}
