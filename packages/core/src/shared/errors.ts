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
  | "ATTEMPT_LIMIT"
  | "INVALID_CHALLENGE"
  | "VERIFICATION_FAILED"
  | "BAD_ARTIFACT"
  | "ARTIFACT_AUTH_FAILED"
  | "INVALID_RANGE"
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
