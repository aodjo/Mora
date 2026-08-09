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
  | "CANCELLED"
  | "EDIT_LOCKED"
  | "INVALID_DRAFT"
  | "ATTEMPT_LIMIT"
  | "INVALID_CHALLENGE"
  | "VERIFICATION_FAILED"
  | "BAD_ARTIFACT"
  | "ARTIFACT_AUTH_FAILED"
  | "YOUTUBE_KEY_MISSING"
  | "YOUTUBE_SEARCH_FAILED"
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
