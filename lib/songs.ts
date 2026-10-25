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
];

export function findSong(id: string): SongMeta | undefined {
  return SONGS.find((s) => s.id === id);
}
