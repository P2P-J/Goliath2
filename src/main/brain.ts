/**
 * 뇌 — 교체 가능한 부품.
 *
 * 입(TTS)을 `backends.py` 의 `TtsBackend` 뒤에 둔 것과 같은 이유다.
 * 어느 모델을 쓸지는 상황에 따라 달라지고, 그 선택이 앱 나머지를 흔들면 안 된다.
 *
 * 구현
 *   ClaudeSubscriptionBrain  이미 내고 있는 클로드 구독을 쓴다. 기본값.
 *   ClaudeApiBrain           API 키를 쓴다. 별도 과금.
 *   (예정) GeminiBrain, LocalBrain
 */

export interface BrainEvents {
  /** 문장이 완성될 때마다. 음성으로 내보낼 단위다. */
  onSentence: (sentence: string) => void;
  /** 화면 표시용. 누적 텍스트가 갱신될 때마다. */
  onText: (fullText: string) => void;
  /** 도구를 쓰기 시작했을 때. */
  onToolUse: (name: string) => void;
  onError: (message: string) => void;
}

export interface Brain {
  readonly name: string;
  /** 쓸 수 있는 상태인지. 자격증명 확인까지 한다. */
  connect(): Promise<boolean>;
  /** 한 턴을 주고받는다. 화면에 표시할 전문을 돌려준다. */
  ask(userText: string, events: BrainEvents): Promise<string>;
  /** 진행 중인 응답을 중단한다 (끼어들기). */
  abort(): void;
  /** 대화 맥락을 버린다 (기억 만료). */
  reset(): void;
  dispose(): Promise<void>;
}

/** 골리앗의 인격. 어느 뇌를 쓰든 같아야 한다. */
export const SYSTEM_PROMPT = `당신은 골리앗입니다. 사용자의 맥에서 상시 구동되는 개인 음성 비서입니다.

## 대화 방식

당신의 답변은 **소리로 재생되면서 동시에 화면에 글로 표시**됩니다.
사용자는 말로 묻고 답을 귀로 듣습니다. 읽는 글이 아니라 듣는 말로 쓰세요.

- 짧게 답하세요. 한두 문장이면 충분한 것을 문단으로 늘리지 마세요.
- 서론을 붙이지 마세요. "네, 알겠습니다. 말씀하신 내용은…" 대신 바로 답하세요.
- 나열하기보다 요지를 말하세요. 자세한 것은 화면에 있습니다.
- 마크다운 기호(**, ##, -)를 쓰지 마세요. 소리로 읽으면 의미가 없습니다.
- 코드는 화면용입니다. 읽어주지 말고 "작성했습니다"라고 하세요.

## 말투

차분하고 유능한 집사입니다. 과장하지 않고, 아첨하지 않고, 필요한 말만 합니다.
"말씀하신 파일을 준비해 두었습니다." 같은 톤입니다.
모르면 모른다고 하세요. 추측을 사실처럼 말하지 마세요.`;
