// 서버와 말하는 자리. 화면 쪽에서 fetch 를 직접 부르지 않는다.

/** 사람이 두드려 넣은 낱말 시각. 아직 안 찍은 것은 at 이 null 이다. */
export interface Word {
  text: string;
  at: number | null;
  end?: number | null;
}

export interface Line {
  at: number;
  /** 줄이 끝나는 자리. LRCLIB 의 `lyricsfile` 에만 있고 LRC 형식·바이브에는 없다. */
  end?: number;
  text: string;
  words?: Word[];
}

export type Verdict = "good" | "off" | "wrong" | "drop" | null;

export interface Song {
  id: number;
  video_id: string;
  artist: string;
  title: string;
  language: string;
  duration: number;
  verdict: Verdict;
  note: string;
  offset_ms: number;
  line_count: number;
  has_audio: boolean;
  lines?: Line[];
}

export interface LyricHit {
  artist: string;
  title: string;
  album: string;
  duration: number;
  lines: Line[];
  instrumental: boolean;
}

export interface AudioHit {
  video_id: string;
  title: string;
  uploader: string;
  duration: number;
}

async function ask<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!response.ok) {
    // 서버가 붙여 보내는 사연을 그대로 올린다. "요청 실패" 만 띄우면 고칠 수가 없다.
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.detail ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const listSongs = () => ask<Song[]>("/api/songs");
export const getSong = (id: number) => ask<Song>(`/api/songs/${id}`);
export const editSong = (id: number, patch: Partial<Song>) =>
  ask<Song>(`/api/songs/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const dropSong = (id: number) =>
  ask<{ ok: boolean }>(`/api/songs/${id}`, { method: "DELETE" });
export const addSong = (song: {
  video_id: string; artist: string; title: string; duration: number; lines: Line[];
}) => ask<Song>("/api/songs", { method: "POST", body: JSON.stringify(song) });

/** 가사 출처. 한국 곡은 바이브가 낫다 — LRCLIB 은 로마자로 적힌 시트가 많다. */
export type LyricSource = "vibe" | "lrclib";

/** 가사 찾기. 제목만·아티스트만·둘 다 — 서버가 조합에 맞는 질의로 바꾼다. */
export const findLyrics = (source: LyricSource, query: { q?: string; artist?: string; title?: string }) =>
  ask<LyricHit[]>(`/api/${source}?` + new URLSearchParams(query as Record<string, string>));

/** 음원 찾기. */
export const findAudio = (q: string, want = 8) =>
  ask<AudioHit[]>(`/api/youtube?${new URLSearchParams({ q, want: String(want) })}`);

export const startFetch = (videoId: string) =>
  ask<{ state: string }>(`/api/audio/${videoId}`, { method: "POST" });
export const fetchState = (videoId: string) =>
  ask<{ state: string }>(`/api/audio/${videoId}`);

export const clock = (seconds: number) => {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};
