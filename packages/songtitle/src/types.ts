import type { BrowserRunner } from "./browser.js";

/** 검색 질의: 최소 제목, 선택적으로 아티스트/프로바이더별 트랙 ID */
export interface SearchQuery {
  title: string;
  artist?: string | undefined;
  /** 이미 알고 있는 프로바이더 트랙 ID (있으면 검색 단계를 건너뜀) */
  trackId?: string | undefined;
}

/** 타임 싱크 가사 한 줄 */
export interface LyricLine {
  /** 곡 시작 기준 오프셋(ms) */
  timeMs: number;
  text: string;
}

/** 한 프로바이더가 반환한 가사 결과 */
export interface LyricsResult {
  provider: string;
  title?: string | undefined;
  artist?: string | undefined;
  album?: string | undefined;
  /** 줄바꿈으로 구분된 평문 가사 */
  lyrics: string;
  /** 프로바이더가 제공하면 타임 싱크 가사 */
  synced?: LyricLine[] | undefined;
  /** 원본 페이지 URL */
  url?: string | undefined;
  /** 프로바이더 고유 ID */
  trackId?: string | undefined;
}

/** 각 프로바이더 fetch에 주입되는 실행 컨텍스트 */
export interface ProviderContext {
  keys: Record<string, string | undefined>;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  fetchImpl: typeof fetch;
  /** 브라우저 폴백 러너 (browser 모드일 때만 주입됨) */
  browser?: BrowserRunner | undefined;
}

/** 프로바이더 어댑터 계약 */
export interface Provider {
  readonly name: string;
  /** API 키 없이는 (HTTP만으로는) 동작 불가하면 true */
  readonly requiresKey?: boolean | undefined;
  /** 읽어들이는 키(env) 이름 — 메시지 표기에 사용 */
  readonly keyName?: string | undefined;
  /** 키가 없어도 브라우저 폴백으로 동작 가능하면 true (라우터 스킵 방지) */
  readonly browserCapable?: boolean | undefined;
  /** 브라우저 없이는 아예 시도조차 못 하면 true (가용성 보고에서 "죽었다"고 알린다) */
  readonly needsBrowser?: boolean | undefined;
  /** 가사를 찾으면 결과, 못 찾으면 null, 오류면 throw */
  fetch(query: SearchQuery, ctx: ProviderContext): Promise<LyricsResult | null>;
}

export type ProviderStatus = "ok" | "not_found" | "skipped" | "error";

/** 라우터가 프로바이더별로 기록하는 실행 결과 */
export interface ProviderOutcome {
  provider: string;
  status: ProviderStatus;
  result?: LyricsResult | undefined;
  error?: string | undefined;
  elapsedMs: number;
}

/** fetchAll 최종 응답 */
export interface RouterResponse {
  query: SearchQuery;
  /** 성공한 프로바이더의 가사들 (전부) */
  results: LyricsResult[];
  /** 프로바이더별 상태 (성공/미검색/스킵/오류 포함) */
  outcomes: ProviderOutcome[];
}
