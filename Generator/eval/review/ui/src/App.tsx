import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AudioHit, Beat, Line, LyricHit, Song, Verdict } from "./api";
import { addSong, alignState, clock, editSong, fetchState, getSong, listSongs, startAlign, startFetch } from "./api";
import { Console } from "./Console";
import { Finder, type Mode } from "./Finder";
import { Lyrics } from "./Lyrics";
import { Timeline } from "./Timeline";
import { Workspace } from "./Workspace";

type Tab = "listen" | "tap" | "shop";

/** How long an unaligned last line is assumed to run, in milliseconds. */
const FALLBACK_SPAN = 4000;

/** 오른쪽 아래에 잠깐 뜨는 알림. `bad` 는 붉게, `work` 는 일이 끝났다는 뜻으로 초록. */
interface Note { id: number; text: string; kind: "info" | "work" | "bad" }

export default function App() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [song, setSong] = useState<Song | null>(null);
  const [needle, setNeedle] = useState("");
  const [finder, setFinder] = useState<Mode | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const noteId = useRef(0);
  const [tab, setTab] = useState<Tab>("listen");
  /**
   * 지금 울리는 갈래. `origin` 이면 원본이다.
   *
   * 갈래를 바꿔도 **듣던 자리를 지킨다** — 원본과 갈래를 같은 지점에서 번갈아 들어야
   * 무엇이 갈렸는지 귀로 안다. 자리를 잃으면 견줄 수가 없다.
   */
  const [stem, setStem] = useState("origin");
  const [nowMs, setNowMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState("");
  /** 우리 모델로 맞추는 중이면 그 상태. 보컬 뽑기까지 하면 1 분쯤 걸린다. */
  const [aligning, setAligning] = useState("");
  /** 맞추는 동안의 자취. 터미널처럼 쌓아 보인다. */
  const [log, setLog] = useState<Beat[]>([]);
  const [showLog, setShowLog] = useState(false);
  /** 드물게 쓰는 일들을 접어 둔 자리. */
  const [menu, setMenu] = useState(false);
  // 밖을 누르면 닫는다. 마우스가 벗어나야만 닫히면 손가락이나 키보드로는 못 닫는다.
  useEffect(() => {
    if (!menu) return;
    const shut = () => setMenu(false);
    window.addEventListener("pointerdown", shut);
    return () => window.removeEventListener("pointerdown", shut);
  }, [menu]);
  /** 재생 배속. 낱말을 찍을 때는 늦춰야 손이 따라간다. */
  const [rate, setRate] = useState(1);
  /** 음원을 받는 중인 곡. 스무 초쯤 걸리므로 무엇을 기다리는지 내내 보여야 한다. */
  const [pulling, setPulling] = useState<{ title: string; since: number } | null>(null);
  const [waited, setWaited] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  // 배속을 ref 로도 들고 있는다. 갈래를 바꾸면 재생기가 1 로 되돌리는데, 그때 `rate` 를
  // 클로저로 잡으면 옛 값이 실린다.
  const rateRef = useRef(1);
  useEffect(() => { rateRef.current = rate; }, [rate]);

  /**
   * 울리는 갈래를 바꾼다. **듣던 자리와 배속을 그대로 물려준다.**
   *
   * 자리를 지키는 것이 요점이다 — 원본과 갈래를 같은 지점에서 번갈아 들어야 무엇이
   * 갈렸는지 귀로 안다. 처음으로 되감기면 견줄 수가 없다.
   */
  const swapStem = useCallback((key: string, url: string) => {
    const element = audio.current;
    if (!element) return;
    const at = element.currentTime;
    const wasPlaying = !element.paused;
    setStem(key);
    element.src = url;
    // 새 소리를 물리면 자리와 배속이 처음으로 돌아간다. 실을 수 있게 된 뒤에 되돌린다.
    element.addEventListener("loadedmetadata", () => {
      element.currentTime = at;
      element.playbackRate = rateRef.current;
      if (wasPlaying) void element.play();
    }, { once: true });
  }, []);

  // 받는 동안 흐른 시간. 멈춘 것인지 더디는 것인지는 이것으로 가른다.
  useEffect(() => {
    if (!pulling) { setWaited(0); return; }
    const tick = window.setInterval(
      () => setWaited(Math.round((Date.now() - pulling.since) / 1000)), 500);
    return () => window.clearInterval(tick);
  }, [pulling]);

  /**
   * 오른쪽 아래에 쌓이는 알림.
   *
   * 가운데 아래 한 줄짜리로 두었더니 무엇을 눌렀는지가 안 남았다 — 「모두 다시 깔기」처럼
   * 화면이 통째로 바뀌는 일도 알림 하나가 스쳐 지나가고 끝이었다. 음원 받는 알림과 같은
   * 자리에 쌓아 두면 방금 무슨 일이 있었는지 되짚을 수 있다.
   */
  const say = useCallback((text: string, kind: Note["kind"] = "info") => {
    const id = ++noteId.current;
    setNotes((now) => [...now.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setNotes((now) => now.filter((one) => one.id !== id)), 3200);
  }, []);

  const refresh = useCallback(async () => setSongs(await listSongs()), []);
  useEffect(() => { refresh(); }, [refresh]);

  // ── 곡 열기 ───────────────────────────────────────────────────────────
  const open = useCallback(async (id: number) => {
    const got = await getSong(id);
    setSong(got); setNowMs(0); setPlaying(false);
    const element = audio.current;
    setStem("origin");
    if (element) { element.pause(); element.src = `/audio/${got.video_id}`; }
    if (got.has_audio) { setState(""); setPulling(null); return; }
    setState("");
    setPulling({ title: `${got.artist} — ${got.title}`, since: Date.now() });
    await startFetch(got.video_id);
    const tick = window.setInterval(async () => {
      const beat = await fetchState(got.video_id);
      if (beat.state === "done") {
        window.clearInterval(tick); setPulling(null);
        if (audio.current) audio.current.src = `/audio/${got.video_id}?t=${Date.now()}`;
        say("음원 준비됨", "work");
      } else if (beat.state.startsWith("실패")) {
        window.clearInterval(tick); setPulling(null); setState(beat.state);
        say(beat.state, "bad");
      }
    }, 2000);
  }, [say]);

  // ── 재생 ──────────────────────────────────────────────────────────────
  const toggle = useCallback(() => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) { element.play(); setPlaying(true); } else { element.pause(); setPlaying(false); }
  }, []);
  const seek = useCallback((ms: number) => {
    if (audio.current) audio.current.currentTime = Math.max(0, ms) / 1000;
  }, []);

  /**
   * 재생 중에는 매 프레임 시각을 읽는다.
   *
   * `onTimeUpdate` 는 초당 네 번쯤만 온다. 줄은 몇 초에 한 번 바뀌니 그것으로 충분했지만,
   * 낱말은 0.4 초짜리라 **통째로 건너뛴다** — 가라오케가 안 켜지던 이유가 이것이다.
   */
  useEffect(() => {
    if (!playing) return;
    let alive = true;
    const beat = () => {
      if (!alive) return;
      if (audio.current) setNowMs(audio.current.currentTime * 1000);
      requestAnimationFrame(beat);
    };
    const id = requestAnimationFrame(beat);
    return () => { alive = false; cancelAnimationFrame(id); };
  }, [playing]);

  // 재생/정지와 앞뒤 넘기기는 두 화면 어디서나 듣는다. 찍기 쪽에만 두었더니 듣는 중에
  // 스페이스가 페이지를 스크롤시켰다.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (event.key === " ") { event.preventDefault(); toggle(); }
      else if (event.key === "ArrowLeft") {
        event.preventDefault(); seek(Math.max(0, (audio.current?.currentTime ?? 0) * 1000 - 5000));
      } else if (event.key === "ArrowRight") {
        event.preventDefault(); seek((audio.current?.currentTime ?? 0) * 1000 + 5000);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggle, seek]);

  const offset = song?.offset_ms ?? 0;
  const lines = song?.lines ?? [];
  /**
   * 줄이 **실제로 시작하는 때**. 맞춘 글자가 있으면 그 첫 글자를 따르고, 없으면 밖에서 온
   * 줄 시각을 쓴다.
   *
   * 시계가 둘이면 안 된다. 어느 줄을 켤지는 바이브가 준 줄 시각으로 정하면서 글자를 칠하는
   * 것은 우리가 맞춘 글자 시각으로 하고 있었다. 둘은 가운뎃값 76ms, p90 1051ms, 최대
   * 1.4 초까지 어긋난다 — 줄이 아직 회색인 동안 그 줄의 첫 글자들은 이미 제 때를 지나 있다가,
   * 줄이 켜지는 순간 **한꺼번에 흰색으로 튄다.** 반대로 어긋나면 노래는 이미 시작했는데 줄이
   * 회색으로 남는다.
   *
   * 화면이 보여 주는 것은 **우리가 맞춘 결과**다. 그러니 줄을 켜는 것도 그것을 따라야 한다.
   * 옆에 적히는 시각만 바이브 것 그대로 둔다 — 그것은 견줄 자이지 그릴 자가 아니다.
   */
  const startOf = useCallback(
    (line: Line) => line.words?.find((word) => word?.at != null)?.at ?? line.at,
    []);

  /**
   * The time range a line actually occupies.
   *
   * Prefers the aligned characters, which are what the view paints. Lines the model
   * could not place have no characters, so they fall back to the outside line time and
   * run until the next line begins — without that they would never count as sounding
   * and would never light up at all.
   *
   * @param {Line} line - A lyric line, possibly carrying aligned words.
   * @param {Line} [next] - The following line, used to end an unaligned line's range.
   * @returns {[number, number] | null} Start and end in lyric-clock milliseconds.
   */
  const spanOf = useCallback((line: Line, next?: Line): [number, number] | null => {
    const chars = (line.words ?? []).flatMap((word) => word?.chars ?? []);
    if (chars.length) {
      return [chars[0].at, Math.max(...chars.map((one) => one.end ?? one.at))];
    }
    if (line.at == null) return null;
    return [line.at, next?.at ?? line.at + FALLBACK_SPAN];
  }, []);

  /**
   * Every line sounding right now, and which of them the view should centre on.
   *
   * Two voices singing together is normal once lanes exist, and lighting only one of
   * them hides half the song. So the view lights all sounding lines and anchors its
   * scroll on the lowest lane among them — the lead keeps the eye while a backing line
   * appears alongside in its own colour.
   *
   * When nothing is sounding, such as an instrumental gap, both fall back to the last
   * line already started so the view holds its place instead of going blank.
   *
   * @returns {{singing: number[], anchor: number}} Sounding line indexes, and the index
   *   to centre on. `anchor` is -1 before the first line begins.
   */
  const { singing, anchor } = useMemo(() => {
    const at = nowMs - offset;
    const live: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const range = spanOf(lines[i], lines[i + 1]);
      if (range && at >= range[0] && at < range[1]) live.push(i);
    }
    if (live.length) {
      const lead = live.reduce((best, one) =>
        (lines[one].lane ?? 0) < (lines[best].lane ?? 0) ? one : best, live[0]);
      return { singing: live, anchor: lead };
    }
    let found = -1;
    for (let i = 0; i < lines.length; i++) {
      if (startOf(lines[i]) <= at) found = i;
    }
    return { singing: found >= 0 ? [found] : [], anchor: found };
  }, [lines, nowMs, offset, startOf, spanOf]);

  // ── 고치기 ────────────────────────────────────────────────────────────
  const patch = useCallback(async (change: Partial<Song>) => {
    if (!song) return;
    const got = await editSong(song.id, change);
    setSong(got);
    setSongs((all) => all.map((row) => (row.id === got.id ? { ...row, ...got } : row)));
  }, [song]);

  /**
   * 줄과 낱말은 같은 배열에 들어 있으므로 저장 경로를 하나로 둔다.
   *
   * 앞선 판은 둘이 각자 타이머를 잡았다. 줄 눈금을 끌면 줄 시각과 그 줄의 낱말이 함께
   * 바뀌는데 두 저장이 서로의 타이머를 지우고, 늦게 잡힌 쪽이 제 것만 실은 옛 배열을
   * 보내 다른 하나를 되돌렸다.
   */
  // 낱말을 저장하던 자리(`keep`·`shiftLine`·`saveWords`)를 걷어냈다. 사람이 손으로
  // 시각을 고치는 일이 없어졌으므로 저장할 것도 없다 — 맞추기가 곧바로 데이터베이스에 쓴다.
  //
  // 남겨 두면 안 된다. 고칠 수 있게 두면 **모델의 실수가 사람 손을 거쳐 정답으로 굳고**,
  // 그 정답으로 다시 모델을 재게 된다. §4 에 적어 둔 순환이 바로 그것이다.

  /**
   * 우리 모델로 한 번 맞춘다.
   *
   * 화면이 깔아 주던 것은 「줄 구간을 글자 수로 나눈 값」이라 소리와 아무 상관이 없다.
   * 여기서 나오는 것은 실제로 들어 보고 놓은 자리다 — 그래도 **정답이 아니라 출발점**이고,
   * 사람이 고쳐야 의미가 있다.
   */
  /**
   * 맞추기가 끝날 때까지 지켜본다.
   *
   * 서버가 저절로 걸어 둔 것도 여기서 받는다 — 사람이 「모델로 맞추기」를 누를 일이 없다.
   * 사람이 하는 일은 검수뿐이고, 모델이 낸 것이 곧 검수할 대상이다.
   */
  const watchAlign = useCallback((id: number) => {
    const tick = window.setInterval(async () => {
      const beat = await alignState(id).catch(() => ({ state: "실패: 서버에 못 닿음", log: [] as Beat[] }));
      if (beat.log?.length) setLog(beat.log);
      if (beat.state.startsWith("done")) {
        window.clearInterval(tick); setAligning("");
        const [, count] = beat.state.split(" ");
        say(`모델이 ${count} 줄을 맞췄습니다 — 들어 보고 판정하세요`, "work");
        await open(id);
      } else if (beat.state.startsWith("실패")) {
        window.clearInterval(tick); setAligning(""); say(beat.state, "bad");
      } else {
        setAligning(beat.state);
      }
      // 0.7 초마다 본다. 2 초로 두었더니 단계가 훅훅 지나가 터미널이 띄엄띄엄 찼다 —
      // 갈래가 캐시된 곡은 통째로 13 초라 두세 번밖에 안 들여다보게 된다.
    }, 700);
    return () => window.clearInterval(tick);
  }, [say, open]);

  /**
   * 사람이 손으로 거는 맞추기. **갈래부터 다시 만든다.**
   *
   * 캐시를 쓰면 「보컬 뽑음 · 0초」가 찍히는데, 사람이 이걸 누른 것이라면 「지금 코드로
   * 처음부터」라는 뜻이다. 가르는 쪽을 고쳐 놓고 옛 갈래로 맞추면 무엇을 고쳤는지 모른다.
   * 그만큼 오래 걸리므로(곡당 2~4 분) 터미널이 무엇이 도는지 내내 보여 준다.
   */
  const runAlign = useCallback(async () => {
    if (!song) return;
    setAligning("보컬 뽑는 중");
    setLog([]); setShowLog(true);
    try {
      await startAlign(song.id, true);
    } catch (error) {
      setAligning(""); say(String((error as Error).message), "bad"); return;
    }
    // 지켜보기는 **한 벌만** 둔다. 여기에 똑같은 폴링 고리를 따로 두었다가 그쪽에서만
    // `setLog` 를 안 불러 터미널이 안 떴다 — 같은 일을 두 곳에 적으면 반드시 갈린다.
    watchAlign(song.id);
  }, [song, say, watchAlign]);

  /**
   * 아직 안 맞춰진 곡을 열면 곧바로 지켜본다.
   *
   * 서버가 `GET /api/songs/{id}` 에서 이미 걸어 두므로 여기서 다시 걸 필요는 없다.
   * 화면은 「지금 무엇이 도는가」만 보여 주면 된다 — 그것이 없으면 빈 가사를 보며
   * 「왜 안 나오지」 하게 된다.
   */
  useEffect(() => {
    if (!song || !song.has_audio || aligning) return;
    if (song.lines?.some((one) => one.words?.length)) return;
    setAligning("보컬 뽑는 중");
    setLog([]); setShowLog(true);
    return watchAlign(song.id);
  }, [song, aligning, watchAlign]);

  // ── 넣기 ──────────────────────────────────────────────────────────────
  const onPick = useCallback(async ({ lyric, audio: picked }: { lyric?: LyricHit; audio?: AudioHit }) => {
    setFinder(null);
    try {
      if (finder === "audio" && picked && song) {
        await patch({ video_id: picked.video_id });
        say("음원 바꿈", "work"); await open(song.id); return;
      }
      if (!lyric) return;
      let videoId = picked?.video_id;
      if (!videoId) {
        say("음원 찾는 중");
        const found = await fetch(`/api/youtube?q=${encodeURIComponent(`${lyric.artist} ${lyric.title}`)}&want=5`);
        const rows: AudioHit[] = await found.json();
        videoId = rows.filter((row) => row.duration)
          .sort((a, b) => Math.abs(a.duration - lyric.duration) - Math.abs(b.duration - lyric.duration))[0]?.video_id;
      }
      if (!videoId) { say("음원을 못 찾음", "bad"); return; }
      const made = await addSong({
        video_id: videoId, artist: lyric.artist, title: lyric.title,
        duration: lyric.duration, lines: lyric.lines,
      });
      await refresh(); await open(made.id); say(`넣었습니다 — ${made.artist} ${made.title}`, "work");
    } catch (error) {
      say(String((error as Error).message), "bad");
    }
  }, [finder, song, patch, open, refresh, say]);

  const shown = useMemo(() => {
    const dust = needle.trim().toLowerCase();
    return dust ? songs.filter((row) => `${row.artist} ${row.title}`.toLowerCase().includes(dust)) : songs;
  }, [songs, needle]);

  const tally = useMemo(() => {
    const count = (verdict: Verdict) => songs.filter((row) => row.verdict === verdict).length;
    return [["전체", songs.length], ["맞음", count("good")], ["밀림", count("off")],
            ["틀림", count("wrong")], ["안 들음", songs.filter((row) => !row.verdict).length]] as const;
  }, [songs]);

  return (
    <div className="app">
      <aside className="rail">
        <div className="rail-top">
          <div className="brand">정답 검수</div>
          <div className="tally">
            {tally.map(([label, n]) => (
              <span className="chip" key={label}>{label} <b>{n}</b></span>
            ))}
          </div>
        </div>
        <div className="rail-find">
          {/* 치던 말이 곧 검색어다. 담긴 곡은 그 자리에서 걸러 보이고, 없으면 찾아 넣는다 —
              「목록에서 거르기」라고만 두었더니 검색인 줄 알고 치다 아무것도 안 나왔다. */}
          <input
            placeholder="곡 찾기 — 아티스트나 제목"
            value={needle}
            onChange={(event) => setNeedle(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") setFinder("both"); }}
          />
          <button className="plus" onClick={() => setFinder("both")} title="곡 넣기">+</button>
        </div>
        <div className="rail-list">
          {needle.trim() && (
            <button className="seek-add" onClick={() => setFinder("both")}>
              <b>“{needle.trim()}”</b> 찾아서 넣기 <kbd>Enter</kbd>
            </button>
          )}
          {shown.length === 0 && (
            <div className="pane-empty">
              {songs.length === 0
                ? "아직 곡이 없습니다.\n위에 이름을 치고 Enter 를 누르세요."
                : "담긴 곡 중에는 없습니다."}
            </div>
          )}
          {shown.map((row) => (
            <button key={row.id} className="row" onClick={() => open(row.id)}>
              {song?.id === row.id && (
                <motion.span className="row-mark" layoutId="rowMark"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }} />
              )}
              <div className="row-name">
                <span className={`dot ${row.verdict ?? "none"}`} />{row.title}
              </div>
              <div className="row-sub">{row.artist} · {row.line_count}줄</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="stage">
        <motion.div className="aura"
          animate={{ opacity: playing ? [0.72, 1, 0.72] : 0.45 }}
          transition={{ duration: 7, repeat: playing ? Infinity : 0, ease: "easeInOut" }} />

        <div className="head">
          <div className="head-meta">
            <div className="t">
              <input value={song?.title ?? ""} placeholder="제목" disabled={!song}
                onChange={(event) => song && setSong({ ...song, title: event.target.value })}
                onBlur={(event) => song && patch({ title: event.target.value }).then(() => say("제목 저장", "work"))} />
            </div>
            <div className="a">
              <input value={song?.artist ?? ""} placeholder="아티스트" disabled={!song}
                onChange={(event) => song && setSong({ ...song, artist: event.target.value })}
                onBlur={(event) => song && patch({ artist: event.target.value }).then(() => say("아티스트 저장", "work"))} />
            </div>
          </div>
          {/*
            사람이 하는 일은 **판정 하나**다. 맞추는 것은 모델의 몫이니 판정만 앞에 두고
            나머지는 접는다 — 같은 무게의 단추 일곱 개가 한 줄에 서 있으면 무엇이 이 화면의
            일인지 안 읽힌다.
          */}
          <div className="acts">
            <div className="verdicts">
              {([["good", "맞음"], ["off", "밀림"], ["wrong", "틀림"]] as const).map(([key, label]) => (
                <button key={key} disabled={!song}
                  className={`verdict ${key} ${song?.verdict === key ? "on" : ""}`}
                  onClick={() => {
                    const next = song?.verdict === key ? null : key;
                    patch({ verdict: next });
                    say(next ? `${label} 으로 표시` : "표시 지움", next === "wrong" ? "bad" : "work");
                  }}>{label}</button>
              ))}
            </div>
            {aligning && (
              <span className="act-busy"><span className="spin" /> {aligning}</span>
            )}
            {/* 창 전체의 「밖을 누르면 닫기」가 여기까지 닿으면 열자마자 닫힌다. 이 안의
                누름은 밖으로 안 내보낸다. */}
            <div className="more" onPointerDown={(event) => event.stopPropagation()}>
              <button className="act ghost" disabled={!song} onClick={() => setMenu((on) => !on)}
                title="그 밖의 일">⋯</button>
              <AnimatePresence>
                {menu && (
                  <motion.div className="more-list"
                    initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.14 }}
                    onMouseLeave={() => setMenu(false)}
                  >
                    <button disabled={!song || !!aligning}
                      onClick={() => { setMenu(false); runAlign(); }}
                      title="갈래부터 다시 만든다 · 곡당 2~4분">처음부터 다시 맞추기</button>
                    <button disabled={!song}
                      onClick={() => { setMenu(false); setFinder("audio"); }}>음원 바꾸기</button>
                    <button onClick={() => { setMenu(false); location.href = "/api/export"; }}>
                      정답 내보내기
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {song && (
          <div className="tabs">
            {/* 「낱말 찍기」가 아니라 「타임라인」이다. 손으로 찍는 일은 없어졌고, 이 화면은
                모델이 놓은 자리를 눈으로 훑어보는 곳이다. */}
            {([["listen", "듣기"], ["tap", "타임라인"], ["shop", "작업실"]] as const).map(([key, label]) => (
              <button key={key} className={`tab ${tab === key ? "on" : ""}`} onClick={() => setTab(key)}>
                {label}
                {tab === key && <motion.span className="tab-mark" layoutId="tabMark"
                  transition={{ type: "spring", stiffness: 420, damping: 32 }} />}
              </button>
            ))}
            {/*
              「여기서 찍기」를 없앴다. 사람이 손으로 낱말을 놓는 일은 이제 없다 — 정확히
              내놓는 것은 모델의 몫이고, 사람은 그 결과를 듣고 판정만 한다. 손으로 고칠 수
              있게 두면 **모델의 실수가 사람 손을 거쳐 정답으로 굳는다.**

              세 화면이 같은 재생 위치를 본다. 오갈 때 자리를 잃지 않는다.
            */}
            <div className="tab-nav">
              {stem !== "origin" && (
                <button className="stem-now" onClick={() => song && swapStem("origin", `/audio/${song.video_id}`)}>
                  {stem === "vocals" ? "보컬" : stem === "lead" ? "리드" : "서브"} 듣는 중 · 원본으로
                </button>
              )}
              <span>{clock(nowMs / 1000)} 지점</span>
            </div>
          </div>
        )}

        {!song ? (
          <div className="empty-note">왼쪽 ＋ 로 곡을 찾아 넣으세요. 가사는 LRCLIB, 음원은 유튜브에서 가져옵니다.</div>
        ) : tab === "listen" ? (
          <Lyrics lines={lines} offsetMs={offset} anchor={anchor} singing={singing}
                  nowMs={nowMs} onSeek={seek} />
        ) : tab === "shop" ? (
          <Workspace songId={song.id} stem={stem} onStem={swapStem}
                     nowMs={nowMs} totalMs={total || song.duration * 1000}
                     busy={Boolean(aligning)} />
        ) : (
          /* 오디오 시각을 그대로 넘긴다. 보정치는 타임라인이 가사를 밀어 그리는 데 쓴다 —
             재생바는 실제 재생 위치이므로 보정한다고 뛰면 안 된다. */
          <Timeline
            key={song.id}
            lines={lines} nowMs={nowMs} offsetMs={offset}
            durationMs={total || song.duration * 1000} onSeek={seek}
          />
        )}

        <div className="foot">
          <div className="foot-bar">
            <button className="play" onClick={toggle} disabled={!song || !!pulling}>
              {pulling ? <span className="spin dark" /> : playing ? "❚❚" : "▶"}
            </button>
            <span className="stamp">{clock(nowMs / 1000)}</span>
            <div className="seek" onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              if (total) seek(((event.clientX - box.left) / box.width) * total);
            }}>
              <div className="seek-track" />
              <div className="seek-fill" style={{ width: `${total ? (nowMs / total) * 100 : 0}%` }} />
              <div className="seek-knob" style={{ left: `${total ? (nowMs / total) * 100 : 0}%` }} />
            </div>
            <span className="stamp">{clock(total / 1000)}</span>
          </div>
          <div className="foot-nudge">
            <span>치우침 보정</span>
            {[-500, -100, 100, 500].map((step) => (
              <button key={step} disabled={!song}
                onClick={() => {
                  const next = (song?.offset_ms ?? 0) + step;
                  patch({ offset_ms: next });
                  say(`치우침 ${next > 0 ? "+" : ""}${next} ms`);
                }}>
                {step > 0 ? "+" : "−"}{Math.abs(step) / 1000}초
              </button>
            ))}
            <span className="offv">{offset} ms</span>
            <button disabled={!song} onClick={() => { patch({ offset_ms: 0 }); say("치우침 되돌림"); }}>되돌리기</button>
            {/* 배속. 낱말을 찍을 때 0.5× 로 늦추면 손이 따라간다. 음높이는 그대로 둔다 —
                브라우저가 기본으로 보존하므로 가사를 알아듣는 데 지장이 없다. */}
            <span className="rate">
              <span>배속</span>
              {[0.5, 0.75, 1, 1.25, 1.5].map((one) => (
                <button key={one} className={rate === one ? "on" : ""}
                  onClick={() => {
                    setRate(one);
                    if (audio.current) audio.current.playbackRate = one;
                  }}>{one}×</button>
              ))}
            </span>
            <span style={{ marginLeft: "auto" }}>
              {state && <><span className="spin" /> {state}</>}
            </span>
          </div>
        </div>
      </main>

      <audio
        ref={audio} preload="metadata"
        onTimeUpdate={(event) => setNowMs(event.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(event) => {
          setTotal(event.currentTarget.duration * 1000);
          // 새 음원을 물리면 배속이 1 로 돌아간다. 고른 값을 다시 건다.
          event.currentTarget.playbackRate = rate;
        }}
        onEnded={() => setPlaying(false)}
      />

      {/* 맞추는 동안의 터미널. 끝나도 사람이 닫을 때까지 남는다 — 무엇이 있었는지 읽을
          자리가 있어야 한다. */}
      <AnimatePresence>
        {/* 자취가 아직 안 왔어도 띄운다. 「눌렀는데 아무 일도 안 일어난다」가 없어야 한다. */}
        {showLog && (
          <Console log={log} running={Boolean(aligning)} onClose={() => setShowLog(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {finder && (
          <Finder
            mode={finder}
            // 음원만 바꿀 때는 지금 곡 이름을, 새로 넣을 때는 왼쪽에 치던 말을 물려준다.
            seedArtist={finder === "audio" ? song?.artist : needle.trim()}
            seedTitle={finder === "audio" ? song?.title : ""}
            wantSeconds={finder === "audio" ? song?.duration : undefined}
            onClose={() => setFinder(null)} onPick={onPick}
          />
        )}
      </AnimatePresence>

      {/* 음원 받는 중. 스무 초쯤 걸리고 그동안 재생이 안 되므로, 무엇을 기다리는지
          내내 보인다. 아래 구석 작은 글씨로는 사람이 못 보고 재생 단추만 눌러 댔다. */}
      <AnimatePresence>
        {pulling && (
          <motion.div className="pulling"
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 340, damping: 28 }}>
            <span className="spin" />
            <span className="pulling-main">
              <b>음원 받는 중</b>
              <span className="pulling-song">{pulling.title}</span>
            </span>
            <span className="pulling-clock">{waited}초</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {notes.map((one, index) => (
          <motion.div
            key={one.id}
            className={`note ${one.kind}`}
            style={{ bottom: 24 + (notes.length - 1 - index) * 58 + (pulling ? 74 : 0) }}
            initial={{ opacity: 0, x: 24, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          >
            {one.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
