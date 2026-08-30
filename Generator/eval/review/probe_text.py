#!/usr/bin/env python3
"""곡 하나의 가사 줄을 번호와 함께 찍는다. 사람이 짚어 준 자리를 대질할 때 쓴다.

@example
  python probe_text.py 7 16 24
"""
import json
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
song = int(sys.argv[1]) if len(sys.argv) > 1 else 7
since = int(sys.argv[2]) if len(sys.argv) > 2 else 0
until = int(sys.argv[3]) if len(sys.argv) > 3 else 999

lines = json.loads(conn.execute("SELECT lines FROM songs WHERE id=?", (song,)).fetchone()[0])
for index in range(max(0, since), min(len(lines), until)):
    text = lines[index].get("text", "")
    print(f"  {index:>3}  {text}")
