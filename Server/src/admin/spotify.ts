/**
 * 플레이리스트 하나를 곡 목록으로.
 *
 * 사람이 이미 골라 놓은 목록은 차트보다 나은 씨앗이다. 차트는 백 곡을 인기순으로 줄 뿐이지만
 * 플레이리스트는 누군가 듣고 싶어서 모은 것이고, 무엇보다 Spotify 는 곡마다 ISRC 를 들고 있다 —
 * 그것이 있으면 어느 녹음인지가 처음부터 정해지므로, 이름으로 더듬어 찾는 일이 통째로 사라진다.
 *
 * 공개된 플레이리스트만 읽으므로 사람의 계정에 들어갈 일이 없다. client credentials 로 앱 자신을
 * 밝히고, 그 토큰으로 공개 자료만 읽는다.
 */

export interface SpotifyTrack {
  artist: string;
  title: string;
  album?: string;
  duration_ms?: number;
  isrc?: string;
  artwork?: string;
}

interface TokenAnswer {
  access_token?: string;
  expires_in?: number;
}

interface PlaylistPage {
  items?: Array<{
    track?: {
      name?: string;
      duration_ms?: number;
      is_local?: boolean;
      type?: string;
      artists?: Array<{ name?: string }>;
      album?: { name?: string; images?: Array<{ url?: string; width?: number }> };
      external_ids?: { isrc?: string };
    } | null;
  }>;
  next?: string | null;
  total?: number;
}

/** 플레이리스트 주소나 URI 에서 식별자만. */
export function playlistId(given: string): string | undefined {
  const trimmed = given.trim();
  const fromUri = /^spotify:playlist:([A-Za-z0-9]+)$/u.exec(trimmed);
  if (fromUri?.[1] !== undefined) return fromUri[1];
  const fromUrl = /open\.spotify\.com\/(?:[a-z-]+\/)?playlist\/([A-Za-z0-9]+)/u.exec(trimmed);
  if (fromUrl?.[1] !== undefined) return fromUrl[1];
  // 식별자만 붙여넣는 사람도 있다.
  return /^[A-Za-z0-9]{16,40}$/u.test(trimmed) ? trimmed : undefined;
}

async function appToken(id: string, secret: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${id}:${secret}`)}`,
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) throw new Error(`SPOTIFY_TOKEN_${response.status}`);
  const answer = (await response.json()) as TokenAnswer;
  if (typeof answer.access_token !== "string") throw new Error("SPOTIFY_TOKEN_EMPTY");
  return answer.access_token;
}

/**
 * 플레이리스트에 담긴 곡들.
 *
 * 한 번에 백 곡씩 오므로 다음 쪽을 따라간다. 천 곡에서 멈추는 것은 장바구니가 사람이 훑어볼
 * 목록이기 때문이다 — 그보다 길면 담는 것이 아니라 쏟아붓는 것이 된다.
 */
export async function playlistTracks(
  playlist: string,
  keys: { id: string; secret: string },
  fetcher: typeof fetch = fetch,
  limit = 1000,
): Promise<{ name?: string; tracks: SpotifyTrack[]; total: number }> {
  const token = await appToken(keys.id, keys.secret, fetcher);
  const headers = { authorization: `Bearer ${token}` };

  let name: string | undefined;
  const named = await fetcher(`https://api.spotify.com/v1/playlists/${playlist}?fields=name`, { headers });
  if (named.ok) name = ((await named.json()) as { name?: string }).name;

  const tracks: SpotifyTrack[] = [];
  let total = 0;
  let url: string | null =
    `https://api.spotify.com/v1/playlists/${playlist}/tracks` +
    "?limit=100&fields=total,next,items(track(name,duration_ms,is_local,type,artists(name),album(name,images),external_ids(isrc)))";
  while (url !== null && tracks.length < limit) {
    const response: Response = await fetcher(url, { headers });
    if (!response.ok) throw new Error(`SPOTIFY_PLAYLIST_${response.status}`);
    const page = (await response.json()) as PlaylistPage;
    total = page.total ?? total;
    for (const row of page.items ?? []) {
      const track = row.track;
      // 팟캐스트 에피소드와 사람이 올린 파일은 우리가 다룰 녹음이 아니다.
      if (track === null || track === undefined || track.is_local === true) continue;
      if (track.type !== undefined && track.type !== "track") continue;
      const artist = (track.artists ?? [])
        .map((one) => one.name ?? "")
        .filter((one) => one.length > 0)
        .join(", ");
      const title = track.name ?? "";
      if (artist.length === 0 || title.length === 0) continue;
      // 표지는 가장 큰 것이 목록에서 가장 먼저 온다.
      const artwork = track.album?.images?.[0]?.url;
      tracks.push({
        artist,
        title,
        ...(track.album?.name === undefined ? {} : { album: track.album.name }),
        ...(track.duration_ms === undefined ? {} : { duration_ms: track.duration_ms }),
        ...(track.external_ids?.isrc === undefined ? {} : { isrc: track.external_ids.isrc }),
        ...(artwork === undefined ? {} : { artwork }),
      });
      if (tracks.length >= limit) break;
    }
    url = page.next ?? null;
  }
  return { ...(name === undefined ? {} : { name }), tracks, total };
}
