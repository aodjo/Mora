export type AdminItem = Record<string, unknown>;

export function text(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function shortId(value: unknown): string {
  const id = text(value);
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function time(value: unknown): string {
  return typeof value === "number" ? new Date(value).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

export function relativeTime(value: unknown): string {
  if (typeof value !== "number") return "기록 없음";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 10) return "방금 전";
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}시간 전` : time(value);
}

export function parseArray(value: unknown): string[] {
  try {
    const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function stateLabel(value: unknown): string {
  const labels: Record<string, string> = {
    active: "활성",
    ambiguous: "확인 필요",
    approved: "승인됨",
    candidate_ready: "후보 생성됨",
    cancelled: "취소됨",
    claimed: "할당됨",
    draft: "초안",
    draining: "종료 준비",
    failed: "실패",
    paused: "일시정지",
    pending: "대기",
    published: "게시됨",
    queued: "대기 중",
    rejected: "반려됨",
    review_required: "검수 필요",
    running: "실행 중",
    unsupported_language: "미지원 언어",
    update: "업데이트 필요",
    verified: "확인됨",
    withdrawn: "철회됨",
  };
  const state = text(value, "unknown");
  return labels[state] ?? state;
}

export function stageLabel(value: unknown): string {
  const labels: Record<string, string> = {
    probe: "음원 확인",
    download: "다운로드",
    transcode: "변환",
    separate: "음원 분리",
    coarse_asr: "받아쓰기",
    language_validate: "언어 확인",
    forced_align: "타이밍 정렬",
    diarize: "화자 분석",
    speaker_stems: "화자 스템",
    index: "정리",
    quality_gate: "품질 검사",
    candidate_submit: "후보 제출",
    cleanup: "마무리",
  };
  const stage = text(value, "");
  return labels[stage] ?? stage;
}

export function stateTone(value: unknown): "good" | "warn" | "bad" | "neutral" | "live" {
  const state = text(value, "unknown");
  if (["active", "approved", "candidate_ready", "published", "verified"].includes(state)) return "good";
  if (["running", "claimed"].includes(state)) return "live";
  if (["ambiguous", "draining", "pending", "queued", "review_required", "update"].includes(state)) return "warn";
  if (["cancelled", "failed", "rejected", "unsupported_language", "withdrawn"].includes(state)) return "bad";
  return "neutral";
}
