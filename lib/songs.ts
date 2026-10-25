export type SongStatus = "live" | "test";

export interface SongMeta {
  id: string;
  title: string;
  artist: string;
  videoId: string;
  chartUrl: string;
  /** "test" songs are only visible from allow-listed IPs until their chart is calibrated */
  status: SongStatus;
}

/** All songs. Charts live in /public/charts. Promote a song by changing status to "live". */
export const SONGS: SongMeta[] = [
  {
    id: "12-oclock",
    title: "12 o'clock",
    artist: "정한X조슈아 (SEVENTEEN)",
    videoId: "hdwGWGSfABA",
    chartUrl: "/charts/12-oclock.json",
    status: "live",
  },
  {
    id: "agijagi",
    title: "아기자기",
    artist: "호시 (HOSHI)",
    videoId: "ScdULYbnjOs",
    chartUrl: "/charts/agijagi.json",
    status: "test",
  },
  {
    id: "boyfriend",
    title: "BOYFRIEND",
    artist: "호시 (HOSHI)",
    videoId: "_RUY9qgP-5g",
    chartUrl: "/charts/boyfriend.json",
    status: "test",
  },
  {
    id: "snapback",
    title: "SNAPBACK",
    artist: "호시 (HOSHI)",
    videoId: "Ar11flLQ-bI",
    chartUrl: "/charts/snapback.json",
    status: "test",
  },
  {
    id: "not-personal",
    title: "Not personal",
    artist: "조슈아 (SEVENTEEN)",
    videoId: "ckcpTLaYjKg",
    chartUrl: "/charts/not-personal.json",
    status: "test",
  },
];

export function findSong(id: string): SongMeta | undefined {
  return SONGS.find((s) => s.id === id);
}

export function liveSongs(): SongMeta[] {
  return SONGS.filter((s) => s.status === "live");
}

/** Songs a client may see: everything for privileged connections, live songs otherwise. */
export function visibleSongs(privileged: boolean): SongMeta[] {
  return privileged ? SONGS : liveSongs();
}
