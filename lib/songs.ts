export interface SongMeta {
  id: string;
  title: string;
  artist: string;
  videoId: string;
  chartUrl: string;
}

/** Songs shown on the home screen. Charts live in /public/charts. */
export const SONGS: SongMeta[] = [
  {
    id: "12-oclock",
    title: "12 o'clock",
    artist: "정한X조슈아 (SEVENTEEN)",
    videoId: "hdwGWGSfABA",
    chartUrl: "/charts/12-oclock.json",
  },
  {
    id: "agijagi",
    title: "아기자기",
    artist: "호시 (HOSHI)",
    videoId: "ScdULYbnjOs",
    chartUrl: "/charts/agijagi.json",
  },
  {
    id: "boyfriend",
    title: "BOYFRIEND",
    artist: "호시 (HOSHI)",
    videoId: "_RUY9qgP-5g",
    chartUrl: "/charts/boyfriend.json",
  },
  {
    id: "snapback",
    title: "SNAPBACK",
    artist: "호시 (HOSHI)",
    videoId: "Ar11flLQ-bI",
    chartUrl: "/charts/snapback.json",
  },
];

export function findSong(id: string): SongMeta | undefined {
  return SONGS.find((s) => s.id === id);
}
