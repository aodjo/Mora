/**
 * 검색 결과에서 "질의한 그 곡"을 고르기 위한 매칭.
 *
 * 모든 프로바이더가 검색 첫 항목을 검증 없이 집던 시절, genie는 HOYO-MiX 게임 OST 질의에
 * Tyler, The Creator의 "Window"를 반환했고 melon은 라틴어 가사 하나를 88곡에 붙였다.
 * 관측된 오염은 전부 제목 불일치였으므로 제목 일치를 필수로 한다.
 *
 * 아티스트는 선호 신호로만 쓴다: MusicBrainz 시드는 "IU"를 주고 한국 서비스는 "아이유"를
 * 보여주므로, 아티스트 불일치만으로 거부하면 표기 체계가 다른 정상 곡을 전부 잃는다.
 * 대신 같은 제목이 여럿일 때(원곡 vs 커버) 아티스트가 맞는 후보를 우선한다.
 */

/** 비교용 정규화: NFKC, 소문자, 문자·숫자만 남긴다 */
export function comparable(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 두 제목이 같은 곡을 가리키는가 — "(Feat. …)" 꼬리 등은 포함 관계로 흡수 */
export function sameTitle(candidate: string | undefined, wanted: string): boolean {
  return titleAffinity(candidate, wanted) > 0;
}

/**
 * 0 = 다른 곡, 1 = 포함 관계("SWIM" ⊂ "I Swim How Bts"도 여기 걸린다), 2 = 정규화 후 동일.
 * 포함만으로 같은 곡 취급하면 "SWIM BTS" 검색 1위였던 "I Swim How Bts"가 진짜
 * "SWIM"(3위, 정확 일치)을 밀어낸다 — 정확 일치가 항상 이겨야 한다.
 */
function titleAffinity(candidate: string | undefined, wanted: string): number {
  if (candidate === undefined) return 0;
  const a = comparable(candidate);
  const b = comparable(wanted);
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 2;
  return a.includes(b) || b.includes(a) ? 1 : 0;
}

/** 아티스트 표기가 겹치는가 — "아이유(IU)" vs "IU" 같은 병기를 포함 관계로 흡수 */
export function sameArtist(candidate: string | undefined, wanted: string | undefined): boolean {
  if (candidate === undefined || wanted === undefined) return false;
  const a = comparable(candidate);
  const b = comparable(wanted);
  if (a.length === 0 || b.length === 0) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export interface TrackCandidate {
  title?: string | undefined;
  artist?: string | undefined;
}

/**
 * 질의한 그 곡일 가능성이 높은 순으로 고른다:
 * 정확한 제목 + 아티스트 일치 > 정확한 제목 > 포함 제목 + 아티스트 > 포함 제목.
 * 같은 계층 안에서는 검색 순위를 따르고, 제목이 겹치지 않으면 undefined — 그 곡이 없는 것이다.
 */
export function pickTrack<T>(
  items: readonly T[],
  wanted: { title: string; artist?: string | undefined },
  read: (item: T) => TrackCandidate,
): T | undefined {
  let best: T | undefined;
  let bestRank = 0;
  for (const item of items) {
    const candidate = read(item);
    const affinity = titleAffinity(candidate.title, wanted.title);
    if (affinity === 0) continue;
    const rank = affinity * 2 + (sameArtist(candidate.artist, wanted.artist) ? 1 : 0);
    if (rank > bestRank) {
      best = item;
      bestRank = rank;
    }
  }
  return best;
}
