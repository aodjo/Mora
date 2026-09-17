"""줄 머리 규칙을 곡을 다시 돌리지 않고 견주려고, 곡마다 쌩 가사 결과를 JSON 으로 남긴다.

probe_par 와 같은 곡을 고르고 같은 방식으로 맞춘다. 줄마다 첫 음절 시각·끝·음절 수·레인과 리드
갈래 경로를 적는다 — `MORA_POLISH_HEAD` 를 바꿔 두 번 돌리면 줄마다 어느 쪽이 맞았는지 볼 수 있다.

    MORA_POLISH_HEAD=keep python probe_head_dump.py 11 dumps/keep
"""
import json
import multiprocessing
import os
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))


def one_song(job: tuple[dict, str]) -> str:
    """Align one song from its bare lyrics and write every line's head, grains and lane.

    @param {tuple[dict, str]} job - The song row and the directory to write into.
    @returns {str} The written path.
    """
    import align
    from probe_blind import words_of

    row, dest = job
    began = time.time()
    found = align.source_in(HERE / "audio", row["video_id"])
    lines = json.loads(row["lines"])
    out, lanes = align.align_voices(found, [{**one, "at": None} for one in lines], words_of, row["title"])
    heads = []
    for words in out:
        chars = [one for word in words for one in (word.get("chars") or []) if one.get("at") is not None]
        heads.append({"at": chars[0]["at"], "end": chars[0]["end"], "last": chars[-1]["at"], "grains": len(chars)} if chars else None)
    path = Path(dest) / f"{row['id']}.json"
    json.dump({"id": row["id"], "title": row["title"], "lead": str(found.with_suffix(".lead.wav")),
               "sheet": [one.get("at") for one in lines], "heads": heads,
               "lanes": {str(k): v for k, v in lanes.items()}, "head": align.POLISH_HEAD},
              open(path, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"  끝 [{row['id']}] {row['title'][:16]} · {align.POLISH_HEAD} · {time.time() - began:.0f}초", file=sys.stderr, flush=True)
    return str(path)


def main() -> int:
    """Pick probe_par's songs and dump each one.

    @returns {int} 0 always.
    """
    how_many, dest = int(sys.argv[1]), sys.argv[2]
    Path(dest).mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(HERE / "review.db")
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, title, video_id, lines FROM songs ORDER BY id").fetchall()[:how_many]
    import align
    jobs = []
    for row in rows:
        found = align.source_in(HERE / "audio", row["video_id"])
        lines = json.loads(row["lines"])
        if not found or not found.with_suffix(".lead.wav").exists():
            continue
        if sum(1 for one in lines if one.get("at") is not None) < 8:
            continue
        jobs.append(({key: row[key] for key in row.keys()}, dest))
    with multiprocessing.get_context("spawn").Pool(int(os.environ.get("MORA_PAR", "1"))) as pool:
        pool.map(one_song, jobs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
