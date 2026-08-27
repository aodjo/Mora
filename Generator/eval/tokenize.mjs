// 평가가 실제 파이프라인과 같은 방식으로 낱말을 가르게 한다.
//
// measure.py 가 line.split() 으로 갈랐더니 일본어가 한 줄에 낱말 하나가 됐다. worker.ts 의
// 주석이 바로 그것을 경고하고 있었는데도 — 「怪獣」46 줄이 낱말 46 개가 되어 앵커가 붙을
// 자리가 없었고, 밀도 0.00 이 나왔다. 그것을 일본어의 성질로 읽을 뻔했다.
//
// 파이썬에서 같은 것을 다시 짜면 또 어긋난다. 워커가 쓰는 그 함수를 그대로 부른다.
//
//   echo '{"text":"...","language":"ja"}' | node tokenize.mjs
//
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 이 파일이 저장소 밖으로 복사되어 돌 때가 있다. 상대 경로를 박아 두면 그때 깨지므로,
// dist 를 찾을 때까지 위로 거슬러 올라간다.
const RELATIVE = "dist/packages/core/src/tokenization/tokenizer-v2.js";
function findTokenizer() {
  for (let here = dirname(fileURLToPath(import.meta.url)); ; here = dirname(here)) {
    const candidate = join(here, RELATIVE);
    if (existsSync(candidate)) return candidate;
    if (dirname(here) === here) break;
  }
  for (const root of ["/workspace/Mora", process.cwd()]) {
    const candidate = join(root, RELATIVE);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${RELATIVE} 를 못 찾음 — pnpm build:services 를 먼저 돌릴 것`);
}

const { tokenizeV2 } = await import(pathToFileURL(findTokenizer()).href);

const input = JSON.parse(await new Response(process.stdin).text());
const tokenization = tokenizeV2(input.text, input.language);
const points = Array.from(input.text);
const kept = tokenization.lines.filter((line) => !line.excluded && line.tokenIndices.length > 0);

process.stdout.write(
  JSON.stringify(
    kept.map((line) => ({
      text: points.slice(line.start, line.end).join(""),
      words: line.tokenIndices.map((index) => tokenization.tokens[index]?.canonical ?? ""),
      spans: line.tokenIndices.map((index) => [
        (tokenization.tokens[index]?.start ?? line.start) - line.start,
        (tokenization.tokens[index]?.end ?? line.start) - line.start,
      ]),
    })),
  ),
);
