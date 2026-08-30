// 서버와 말하는 자리. 화면 쪽에서 fetch 를 직접 부르지 않는다.

/** 글자 하나의 시각. 정렬 모델의 어휘가 음절이라 이것이 원래 나오는 단위다. */
export interface Grain {
  text: string;
  at: number;
  end: number;
  /** 모델이 얼마나 확신하나(그 자리에서 고른 것과의 차이). 0 이면 모델도 같은 글자를 들었다. */
  sure?: number;
  /** 그 곡 안에서 유독 자신 없어 한 자리. 사람이 꼭 봐야 한다. */
  shaky?: boolean;
}

/** 사람이 두드려 넣은 낱말 시각. 아직 안 찍은 것은 at 이 null 이다. */
export interface Word {
  text: string;
  at: number | null;
  end?: number | null;
  /** 낱말 안의 글자마다의 시각. 있으면 가라오케를 글자 단위로 칠한다. */
  chars?: Grain[] | null;
  /** 그 어절에서 가장 약한 글자의 확신도. 하나가 어긋나면 그 어절은 믿을 수 없다. */
  sure?: number;
  shaky?: boolean;
  /**
   * 그 **줄**이 무너진 까닭. 줄의 첫 낱말에만 붙는다.
   *
   * 확신도(`sure`)와 다른 자다. 확신도는 모델이 그 글자를 얼마나 확신하느냐인데 이 모델에서는
   * 힘이 약했다 — 나쁜 줄 다섯 중 둘만 잡았다. 이것은 **정렬 결과 안의 모순**을 본다:
   * 같은 글월이 곡에서 다른 길이로 놓였거나, 글자가 죄다 최소 간격에 붙었거나, 줄 안이
   * 몇 초씩 비었거나. 밖에서 온 시각을 안 쓰므로 음원 판이 달라도 흔들리지 않는다.
   */
  stuck?: string;
}

export interface Line {
  at: number;
  /**
   * 어느 목소리인가. 0 = 메인, 1 = 서브(백보컬·애드리브).
   *
   * 없으면 화면이 괄호로 짐작한다. 보컬을 리드/서브로 가른 뒤에는 서버가 **어느 갈래에서
   * 더 잘 맞았는가**로 정해 준다 — 괄호는 가사 적는 이의 버릇이라 못 믿는다.
   */
  lane?: number;
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

/**
 * 우리 모델로 맞춘다. 나온 것을 사람이 듣고 판정한다.
 *
 * `fresh` 면 **갈래부터 다시 만든다.** 캐시를 쓰면 「보컬 뽑음 · 0초」가 찍히는데,
 * 사람이 「다시 맞추기」를 누른 것이라면 그건 「지금 코드로 처음부터」라는 뜻이다.
 */
export const startAlign = (id: number, fresh = false) =>
  ask<{ state: string }>(`/api/songs/${id}/align${fresh ? "?fresh=1" : ""}`, { method: "POST" });
/** 맞추기 자취 한 줄. 서버가 단계마다 쌓는다 — 화면은 이것을 터미널처럼 보인다. */
export interface Beat { at: number; text: string; kind: "step" | "done" | "bad" }

export const alignState = (id: number) =>
  ask<{ state: string; log?: Beat[] }>(`/api/songs/${id}/align`);

export const startFetch = (videoId: string) =>
  ask<{ state: string }>(`/api/audio/${videoId}`, { method: "POST" });
export const fetchState = (videoId: string) =>
  ask<{ state: string }>(`/api/audio/${videoId}`);

export const clock = (seconds: number) => {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};
