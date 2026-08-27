export type ErrorCode =
  | "BAD_JSON"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_TOKENIZER"
  | "UNSUPPORTED_FORMAT"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "MISCONFIGURED"
  | "UPSTREAM_FAILED"
  | "INTERNAL"
  | "FORBIDDEN"
  | "DURATION_REQUIRED"
  | "AMBIGUOUS_RECORDING"
  /** 맞출 가사가 없다 — 타이밍은 글자에 붙는 것이라 이것만은 없으면 안 된다. */
  | "LYRICS_REQUIRED"
  | "CANCELLED"
  | "EDIT_LOCKED"
  | "INVALID_DRAFT"
  | "INVALID_CHALLENGE"
  | "VERIFICATION_FAILED"
  | "BAD_ARTIFACT"
  | "ARTIFACT_AUTH_FAILED"
  | "INVALID_RANGE"
  /** 플레이리스트를 읽을 자격이 설정되지 않았다. */
  | "SPOTIFY_NOT_CONFIGURED"
  /** 준 주소에서 플레이리스트를 알아볼 수 없다. */
  | "INVALID_PLAYLIST"
  /** 자격이 거절당했다 — 사람이 할 일은 열쇠를 다시 넣는 것이다. */
  | "SPOTIFY_AUTH_FAILED"
  /** 플레이리스트에 닿지 못했다 — 비공개이거나 지워졌거나 그 지역에 없다. */
  | "PLAYLIST_UNAVAILABLE"
  | "UNSUPPORTED_ARTIFACT"
  | "SETTING_NOT_FOUND"
  | "INVALID_SETTING_VALUE"
  | "SECRET_DECRYPT_FAILED"
  | "DUMP_NOT_READY";

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
  ) {
    super(code);
    this.name = "ServiceError";
  }
}
