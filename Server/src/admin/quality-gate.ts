/**
 * 아무도 안 볼 때 후보를 공개해도 되는가.
 *
 * 사람이 손으로 승인하는 길은 여기를 지나지 않는다. 이 문턱이 막는 것은 자동 승격뿐이다.
 */

/**
 * 앵커 바닥값. 품질 평균에 섞지 않고 따로 세우는 것은, 평균이 이 둘을 가릴 수 있기 때문이다.
 *
 * 평균에 들어가는 asr_anchored 는 앵커가 하나라도 있으면 1 이다. 낱말의 40% 만 실제로 들린
 * 정렬과 95% 가 들린 정렬이 같은 1 을 받고, 나머지 다섯 지표가 만점이면 둘 다 0.98 로 나간다.
 * 앵커가 없는 낱말은 앞뒤 사이에 비례로 흩뿌려지는데 그 값은 근거가 없다 — 근거 없는 타이밍이
 * "품질 0.98" 을 달고 공개되던 길이 이것이었다.
 *
 * 141 곡을 재어 문턱을 놓았다. 밀도 70% 아래가 18 곡, 빈 구간 20 낱말 초과(reach 0.5 아래)가
 * 10 곡이고 겹쳐서 스무 곡 남짓 — 여덟 곡에 하나쯤이 사람에게 간다. 더 조이면(80%) 마흔한
 * 곡이 되어 검수가 일이 되고, 더 풀면(60%) 열 곡만 남아 놓치는 것이 생긴다.
 */
export const ANCHOR_DENSITY_FLOOR = 0.7;
export const ANCHOR_REACH_FLOOR = 0.5;

export interface CandidateStanding {
  score: number;
  language: number;
  /** 받아쓴 소리에 실제로 맞물린 낱말의 비율. */
  density: number;
  /** 1 - 최장 빈 구간/40. 0.5 는 스무 낱말이 통째로 추측이라는 뜻이다. */
  reach: number;
}

export interface QualityLimits {
  score: number;
  density: number;
  reach: number;
}

export function passesQualityGate(item: CandidateStanding, limits: QualityLimits): boolean {
  return item.score >= limits.score && item.language >= 0.9 && item.density >= limits.density && item.reach >= limits.reach;
}
