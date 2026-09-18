/**
 * 플레이리스트 하나를 곡 목록으로.
 *
 * 사람이 이미 골라 놓은 목록은 차트보다 나은 씨앗이다. 차트는 백 곡을 인기순으로 줄 뿐이지만
 * 플레이리스트는 누군가 듣고 싶어서 모은 것이고, 무엇보다 Spotify 는 곡마다 ISRC 를 들고 있다 —
 * 그것이 있으면 어느 녹음인지가 처음부터 정해지므로, 이름으로 더듬어 찾는 일이 통째로 사라진다.
 *
 * 앱 자격(client credentials)만으로는 이제 못 읽는다. 2024-11-27 이후에 만든 앱에서 `/playlists/{id}/tracks`
 * 는 폐지돼 403 을 주고, 갈음할 `/playlists/{id}/items` 는 「Valid user authentication required」로 401 을
 * 준다. 곡 하나를 묻는 `/tracks` 조차 403 이다.
 *
 * 그런데 **공개 목록은 로그인 없이도 읽힌다** — 누구나 보는 붙임(embed) 화면이 곡 목록을 그대로
 * 싣고 있다. 그래서 공개 목록은 그쪽으로 읽고(앞 100곡), 비공개 목록만 사람이 로그인해 준
 * 토큰으로 읽는다. 로그인을 세우는 데 스포티파이 대시보드에 사람을 등록해야 하는 걸림돌이 있어,
 * 흔한 쪽(공개 목록)이 아무 준비 없이 되는 것이 중요하다.
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
  refresh_token?: string;
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

/** 사람이 로그인해 준 권한. 플레이리스트를 읽는 데 이것 하나면 된다. */
export const SPOTIFY_SCOPE = "playlist-read-private";

/** 붙임 화면이 한 번에 싣는 곡 수. 150곡짜리를 받아 보면 정확히 여기서 끊긴다. */
export const PUBLIC_MOST = 100;

interface EmbedTrack {
  title?: string;
  subtitle?: string;
  duration?: number;
}

interface EmbedPage {
  props?: { pageProps?: { state?: { data?: { entity?: { name?: string; trackList?: EmbedTrack[] } } } } };
}

/**
 * Read a public playlist with nobody logged in.
 *
 * 붙임 화면(`open.spotify.com/embed/playlist/…`)은 누구나 보라고 있는 것이고, 그릴 곡 목록을
 * `__NEXT_DATA__` 에 통째로 싣고 온다. 가수·제목·길이가 거기 다 있다. ISRC 와 앨범은 없지만,
 * 수집기는 이미 가수·제목·길이로 영상을 고르므로 그것만으로 충분하다.
 *
 * @param {string} playlist - The playlist identifier.
 * @param {typeof fetch} [fetcher=fetch] - How to call Spotify.
 * @returns {Promise<{ name?: string; tracks: SpotifyTrack[]; total: number; capped: boolean }>} What the page carried; `capped` when the list stopped at {@link PUBLIC_MOST}.
 * @throws {Error} `SPOTIFY_EMBED_<status>` when the page refuses, `SPOTIFY_EMBED_EMPTY` when it carries no list.
 */
export async function publicPlaylist(
  playlist: string,
  fetcher: typeof fetch = fetch,
): Promise<{ name?: string; tracks: SpotifyTrack[]; total: number; capped: boolean }> {
  const response = await fetcher(`https://open.spotify.com/embed/playlist/${playlist}`, {
    // 사람이 쓰는 브라우저라고 말하지 않으면 빈 껍데기를 준다.
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "ko,en;q=0.8" },
  });
  if (!response.ok) throw new Error(`SPOTIFY_EMBED_${response.status}`);
  const hit = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/u.exec(await response.text());
  if (hit?.[1] === undefined) throw new Error("SPOTIFY_EMBED_EMPTY");
  let entity;
  try {
    entity = (JSON.parse(hit[1]) as EmbedPage).props?.pageProps?.state?.data?.entity;
  } catch {
    throw new Error("SPOTIFY_EMBED_EMPTY");
  }
  const listed = entity?.trackList ?? [];
  const tracks: SpotifyTrack[] = [];
  for (const one of listed) {
    // 여러 가수는 이미 「A, B」로 붙어 온다.
    const artist = (one.subtitle ?? "").trim();
    const title = (one.title ?? "").trim();
    if (artist.length === 0 || title.length === 0) continue;
    tracks.push({
      artist,
      title,
      ...(typeof one.duration === "number" && one.duration > 0 ? { duration_ms: one.duration } : {}),
    });
  }
  if (tracks.length === 0) throw new Error("SPOTIFY_EMBED_EMPTY");
  return {
    ...(entity?.name === undefined ? {} : { name: entity.name }),
    tracks,
    total: tracks.length,
    capped: listed.length >= PUBLIC_MOST,
  };
}

/**
 * Trade an authorization code or a refresh token for an access token.
 *
 * @param {Record<string, string>} grant - The form fields for this grant.
 * @param {{ id: string; secret: string }} keys - The app's credentials.
 * @param {typeof fetch} [fetcher=fetch] - How to call Spotify.
 * @returns {Promise<TokenAnswer>} What Spotify answered.
 * @throws {Error} `SPOTIFY_TOKEN_<status>` when Spotify refuses.
 */
export async function spotifyToken(
  grant: Record<string, string>,
  keys: { id: string; secret: string },
  fetcher: typeof fetch = fetch,
): Promise<TokenAnswer> {
  const response = await fetcher("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${keys.id}:${keys.secret}`)}`,
    },
    body: new URLSearchParams(grant).toString(),
  });
  if (!response.ok) throw new Error(`SPOTIFY_TOKEN_${response.status}`);
  const answer = (await response.json()) as TokenAnswer;
  if (typeof answer.access_token !== "string") throw new Error("SPOTIFY_TOKEN_EMPTY");
  return answer;
}

/** 로그인 보내는 자리. state 는 돌아온 것이 우리가 보낸 것인지 보려고 쓴다. */
export function spotifyAuthorizeUrl(id: string, redirect: string, state: string): string {
  const query = new URLSearchParams({ client_id: id, response_type: "code", redirect_uri: redirect, scope: SPOTIFY_SCOPE, state });
  return `https://accounts.spotify.com/authorize?${query.toString()}`;
}

/**
 * 플레이리스트에 담긴 곡들.
 *
 * 한 번에 백 곡씩 오므로 다음 쪽을 따라간다. 천 곡에서 멈추는 것은 장바구니가 사람이 훑어볼
 * 목록이기 때문이다 — 그보다 길면 담는 것이 아니라 쏟아붓는 것이 된다.
 */
export async function playlistTracks(
  playlist: string,
  token: string,
  fetcher: typeof fetch = fetch,
  limit = 1000,
): Promise<{ name?: string; tracks: SpotifyTrack[]; total: number }> {
  const headers = { authorization: `Bearer ${token}` };

  let name: string | undefined;
  const named = await fetcher(`https://api.spotify.com/v1/playlists/${playlist}?fields=name`, { headers });
  if (named.ok) name = ((await named.json()) as { name?: string }).name;

  const tracks: SpotifyTrack[] = [];
  let total = 0;
  let url: string | null =
    `https://api.spotify.com/v1/playlists/${playlist}/items` +
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
