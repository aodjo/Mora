# 클라이언트는 제 레포로 옮겼습니다

| | |
|---|---|
| 파이썬 | **https://github.com/aodjo/mora-python** — `pip install mora-lyrics` |
| 자바스크립트·타입스크립트 | **https://github.com/aodjo/mora-js** — `npm i mora-lyrics` |

여기 있던 코드는 그 두 레포의 바탕이 되었고, 옮기면서 **화자가 엉뚱한 낱말에 붙던 버그**를
고쳤습니다. 서버의 `word_speakers` 는 **토큰 번호**로 키를 거는데 `/v1/align` 의 `spans` 는
시각이 붙은 토큰만 담아 오므로(`packages/core/src/alignment/project.ts` 의 flatMap) 배열 자리와
번호가 어긋납니다. 옛 코드는 그 자리를 번호로 썼고, 줄 쪽도 같았습니다.

`/v1/tokenize` · `/v1/align/fingerprint`, 자막 내보내기, 재생 도우미도 그때 채웠습니다.

타이밍이 실제로 어떤지 보려면 [`../Welcome`](../Welcome) 을 돌려 보세요.

옛 코드는 git 기록에 남아 있습니다 — `git log -- clients/`.
