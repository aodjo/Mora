# Generator

Mora Generator는 외부 GPU 컴퓨터에서 실행되는 Cloudflare Queue HTTP pull consumer입니다. 자세한 설치와 환경변수는 루트 `README.md`를 참조하세요.

Python daemon은 stdout JSON-RPC만 사용하고 모델을 프로세스에 유지합니다. TypeScript orchestrator가 Queue lease, Admin API, `unilab-v2`, 아티팩트 암호화와 재시도를 담당합니다.

주요 파일:

- `src/worker-cli.ts`: 등록 또는 production worker 진입점
- `src/worker.ts`: 한 곡씩 처리하는 orchestration
- `src/cloudflare-queue.ts`: pull/ack/retry
- `src/admin-client.ts`: 후보·이벤트·암호화 아티팩트 제출
- `python/mora_ml_daemon.py`: yt-dlp/ffmpeg/Demucs/ASR/alignment/diarization

`src/cli.ts`의 HTTP builder는 이전 v0.1 fixture 호환용이며 production 경로가 아닙니다.
