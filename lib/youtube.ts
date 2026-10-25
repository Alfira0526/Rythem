/* Minimal typed wrapper around the YouTube IFrame Player API plus a
 * smoothed clock that turns the player's coarse getCurrentTime() into a
 * continuous song-time usable for judgement. */

export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(v: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData?: () => { video_id?: string } | undefined;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      host?: string;
      videoId: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: { target: YTPlayer }) => void;
        onStateChange?: (e: { data: number; target: YTPlayer }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | null = null;

export function loadYouTubeApi(): Promise<YTNamespace> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("YouTube API loaded without Player"));
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    s.onerror = () => {
      apiPromise = null;
      reject(new Error("YouTube API failed to load"));
    };
    document.head.appendChild(s);
    window.setTimeout(() => reject(new Error("YouTube API timeout")), 20000);
  });
  return apiPromise;
}

export interface CreatePlayerOptions {
  el: HTMLElement;
  videoId: string;
  onStateChange?: (state: number) => void;
  onError?: (code: number) => void;
}

export function createPlayer(opts: CreatePlayerOptions): Promise<YTPlayer> {
  return loadYouTubeApi().then(
    (YT) =>
      new Promise<YTPlayer>((resolve) => {
        new YT.Player(opts.el, {
          host: "https://www.youtube-nocookie.com",
          videoId: opts.videoId,
          width: "100%",
          height: "100%",
          playerVars: {
            playsinline: 1,
            controls: 0,
            disablekb: 1,
            rel: 0,
            fs: 0,
            iv_load_policy: 3,
            modestbranding: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (e) => resolve(e.target),
            onStateChange: (e) => opts.onStateChange?.(e.data),
            onError: (e) => opts.onError?.(e.data),
          },
        });
      }),
  );
}

/**
 * SyncClock: anchors performance.now() to the player's reported time and
 * nudges the anchor whenever a fresh sample disagrees. Small disagreements
 * are blended in; large ones (seek, ad end, buffering) re-anchor at once.
 */
export class SyncClock {
  private anchorSong = 0;
  private anchorPerf = 0;
  private lastSample = -1;
  private running = false;
  /** how far the last sample disagreed with the prediction (sec) */
  public lastError = 0;

  constructor(private readonly player: YTPlayer) {}

  start() {
    this.running = true;
    this.anchorSong = this.safeTime();
    this.anchorPerf = performance.now() / 1000;
    this.lastSample = this.anchorSong;
  }

  stop() {
    this.running = false;
  }

  private safeTime(): number {
    try {
      return this.player.getCurrentTime() || 0;
    } catch {
      return 0;
    }
  }

  /** Call once per animation frame. Returns the smoothed song time (sec). */
  now(): number {
    const perf = performance.now() / 1000;
    if (!this.running) return this.anchorSong;
    const predicted = this.anchorSong + (perf - this.anchorPerf);
    const sample = this.safeTime();
    if (sample !== this.lastSample) {
      this.lastSample = sample;
      const err = sample - predicted;
      this.lastError = err;
      if (Math.abs(err) > 0.12) {
        this.anchorSong = sample;
        this.anchorPerf = perf;
        return sample;
      }
      // blend 15% of the error per fresh sample
      this.anchorSong += err * 0.15;
    }
    return this.anchorSong + (perf - this.anchorPerf);
  }
}

/** True once the video is really advancing (not an ad, not buffering). */
export function isVideoAdvancing(
  player: YTPlayer,
  expectedDuration: number,
  prevTime: number,
): boolean {
  try {
    if (player.getPlayerState() !== YT_STATE.PLAYING) return false;
    const t = player.getCurrentTime();
    const d = player.getDuration();
    if (!(t > prevTime)) return false;
    if (expectedDuration > 0 && d > 0 && Math.abs(d - expectedDuration) > 6) return false;
    return true;
  } catch {
    return false;
  }
}
