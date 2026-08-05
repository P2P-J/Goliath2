# 골리앗 (Goliath)

macOS 개인용 음성 AI 비서. 말로 시키고, 말로 듣고, 말로 전달할 수 없는 결과물은 화면과 파일로 받는다.

**뇌는 Claude, 귀는 Whisper, 입은 Fish Audio.**

기획서: `goliath-plan-v4.md` (별도 관리). 이 문서는 개발 환경만 다룬다.

---

## 지금 상태 — 골격까지

동작하는 것:

- Electron 메인 ↔ Python 음성 엔진의 **stdio 줄단위 JSON 프로토콜** (버전 핸드셰이크, 자동 재기동)
- **상태 기계** 골자 — 2.2절의 두 타이머(청취 창 15초 / 대화 기억 15분)를 분리 구현
- **메뉴바 상주** — 창을 띄우지 않고 기동, 상태 표시, 인식 토글
- **키체인 API 키 저장** — `.env.local` → 키체인 이관 후 평문 삭제
- **효과음 합성** — 6절 레시피를 Web Audio API 로
- 렌더러 상태 오브 + 이벤트 로그

아직 스텁인 것: 웨이크워드, Whisper, Fish Audio, Claude 호출, 음악 플레이어.
전부 `TODO(M1)` ~ `TODO(M5)` 로 표시돼 있고, 프로토콜 파일은 건드리지 않고 채울 수 있다.

---

## 실행

```bash
npm install
npm run dev          # 개발 (HMR)
npm run build        # 타입 검사 + 프로덕션 빌드
npm run typecheck
npm run engine       # 음성 엔진만 단독 실행 (stdin 에 JSON 을 붙여 시험)
```

엔진만 따로 시험하기:

```bash
cd engine
printf '{"type":"listen.start"}\n{"type":"listen.stop"}\n{"type":"shutdown"}\n' \
  | python3 -m goliath_engine
```

### 알려진 함정: `ELECTRON_RUN_AS_NODE`

Electron 기반 에디터(VS Code, Claude Code 등)의 터미널에는 `ELECTRON_RUN_AS_NODE=1`
이 상속돼 있을 수 있다. 이 상태로 앱을 띄우면 Electron 이 순수 Node 로 동작하고
`require('electron')` 이 API 대신 바이너리 경로 문자열을 돌려주면서
`Cannot read properties of undefined (reading 'whenReady')` 로 죽는다.

```bash
env -u ELECTRON_RUN_AS_NODE npx electron out/main/index.js
```

`npm run dev` 는 electron-vite 가 알아서 처리하므로 보통 문제되지 않는다.

---

## API 키 넣기

프로젝트 루트에 `.env.local` 을 만든다:

```
ANTHROPIC_API_KEY=sk-ant-...
FISH_AUDIO_API_KEY=...
```

앱을 처음 실행하면 **키체인으로 옮기고 `.env.local` 에서 지운다** (기획서 8.3절).
확인·삭제는 키체인 접근.app 에서 서비스 이름 `goliath` 로 찾으면 된다.

| 키 | 발급 | 필요 시점 |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com | M1 |
| `FISH_AUDIO_API_KEY` | fish.audio/developers | M1 |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Google Cloud Console (본인 계정을 테스트 사용자로 등록) | M5 |

키가 없으면 그 기능만 막히고 나머지는 동작한다.

---

## 구조

```
src/
  shared/protocol.ts     프로세스 경계 계약. 변경 시 protocol.py 도 함께 (10절)
  main/
    index.ts             메뉴바, 전역 단축키, 엔진 이벤트 라우팅
    engine.ts            음성 엔진 감독 (spawn, 버전 확인, 재기동)
    state.ts             상태 기계 + 두 타이머
    keychain.ts          security CLI 기반 키 저장
  preload/index.ts       렌더러에 노출할 것만
  renderer/
    App.tsx              상태 오브, 이벤트 로그
    sounds.ts            6절 효과음 합성
engine/goliath_engine/
  protocol.py            protocol.ts 의 거울
  __main__.py            명령 루프
  backends.py            귀(STT)/입(TTS) 교체 가능한 뒷단
bench/
  whisper_bench.py       M0 모델별 메모리·지연 실측
```

### 변경 불가 원칙 (기획서 10절)

1. **오디오는 프로세스 경계를 넘지 않는다.** 마이크 입력과 TTS 출력은 음성 엔진
   안에서만 흐른다. 경계를 넘는 것은 짧은 텍스트 JSON뿐이다.
2. **음악은 렌더러가 재생한다.** 덕킹이 UI 상태와 동기화되어야 한다.
3. **음성 엔진은 교체 가능한 부품이다.** `backends.py` 의 인터페이스가 그 경계다.
   Fish Audio 를 갈아끼울 때 `protocol.py` / `protocol.ts` 는 바뀌지 않는다.

`protocol.ts` 와 `protocol.py` 의 `PROTOCOL_VERSION` 이 어긋나면 앱이 기동 시 거부한다.

---

## 다음 (M0)

Whisper 뒷단을 붙이고 실측한다. 기본 모델은 재보고 고른다 — 기획서 7.2절의
수치는 추정치다.

```bash
# 맥
pip install mlx-whisper psutil
python bench/whisper_bench.py samples/ko_30s.wav --backend mlx

# 데스크톱/리눅스
pip install faster-whisper psutil
python bench/whisper_bench.py samples/ko_30s.wav --backend faster
```

**판정 기준** (재기 전에 고정): 스왑아웃 증가 > 0 이면 실격, 발화종료→첫소리
6초 초과면 실격. 통과하는 가장 큰 모델을 채택한다.

openWakeWord 와 Whisper 의존성은 Python 3.12 를 요구할 가능성이 높다
(시스템은 3.14). 모델을 실제로 붙일 때 `uv` 로 3.12 를 고정한다.
