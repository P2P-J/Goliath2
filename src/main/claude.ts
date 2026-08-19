import Anthropic from '@anthropic-ai/sdk';

import { KEYS, getKey } from './keychain';
import { takeCompleteSentences } from './speech-filter';

/**
 * 뇌 — Claude 대화 관리자.
 *
 * 기획서 1절: 참조 모델은 클로드 음성 모드다. 턴 기반으로 듣고, 생각하고, 답한다.
 *
 * 스트리밍으로 받으면서 문장이 완성되는 대로 흘려보낸다. 응답을 다 기다렸다가
 * 말하면 몇 초를 침묵하게 된다 — 대화가 성립하지 않는다.
 */

const MODEL = 'claude-opus-5';

/**
 * 컨텍스트 상한 (8.2절).
 * 전체 대화는 로컬에 보존하되, Claude 에 보내는 것은 최근 분량만 유지한다.
 */
const MAX_HISTORY_TURNS = 40;

const SYSTEM_PROMPT = `당신은 골리앗입니다. 사용자의 맥 데스크톱에서 상시 구동되는 개인 음성 비서입니다.

## 대화 방식

당신의 답변은 **소리로 재생되면서 동시에 화면에 글로 표시**됩니다.
사용자는 말로 묻고, 답을 귀로 듣습니다. 그러니 라디오 진행자처럼 말하세요 —
읽는 글이 아니라 듣는 말입니다.

- 짧게 답하세요. 한두 문장이면 충분한 것을 문단으로 늘리지 마세요.
- 서론을 붙이지 마세요. "네, 알겠습니다. 말씀하신 내용은..." 대신 바로 답하세요.
- 목록을 나열하기보다 요지를 말하세요. 자세한 것은 화면에 있습니다.
- 마크다운 기호(**, ##, - )를 쓰지 마세요. 소리로 읽으면 의미가 없습니다.
- 코드는 화면용입니다. 코드를 읽어주지 말고 "작성했습니다"라고 하세요.

## 말투

차분하고 유능한 집사입니다. 과장하지 않고, 아첨하지 않고, 필요한 말만 합니다.
"말씀하신 파일을 준비해 두었습니다." 같은 톤입니다.
잘 모르면 모른다고 하세요. 추측을 사실처럼 말하지 마세요.

## 도구

웹 검색이 필요하면 쓰세요. 검색 결과는 **핵심만 말하고**, 출처와 자세한 내용은
"화면에 정리해 뒀습니다"로 넘기세요. 링크를 소리로 읽지 마세요.`;

export interface ConversationEvents {
  /** 문장이 완성될 때마다. 음성으로 내보낼 단위다. */
  onSentence: (sentence: string, index: number) => void;
  /** 화면 표시용. 스트리밍 중 누적 텍스트가 갱신될 때마다. */
  onText: (fullText: string) => void;
  /** 도구를 쓰기 시작했을 때. 상태 표시용. */
  onToolUse: (name: string) => void;
  onError: (message: string) => void;
}

export class Conversation {
  private client: Anthropic | null = null;
  private history: Anthropic.MessageParam[] = [];
  private aborter: AbortController | null = null;

  /** 8.2절: 대화 기억이 만료되면 새 대화로 시작한다. */
  reset(): void {
    this.history = [];
  }

  get isReady(): boolean {
    return this.client !== null;
  }

  get turnCount(): number {
    return this.history.length;
  }

  async connect(): Promise<boolean> {
    if (this.client) return true;
    const apiKey = await getKey(KEYS.anthropic);
    if (!apiKey) return false;
    this.client = new Anthropic({ apiKey });
    return true;
  }

  /** 진행 중인 응답을 중단한다 (끼어들기). */
  abort(): void {
    this.aborter?.abort();
    this.aborter = null;
  }

  /**
   * 한 턴을 주고받는다.
   *
   * @returns 화면에 표시할 전문. 중단되면 그때까지 받은 것.
   */
  async ask(userText: string, events: ConversationEvents): Promise<string> {
    if (!this.client) {
      events.onError('ANTHROPIC_API_KEY 가 없습니다. .env.local 에 넣고 재시작하세요.');
      return '';
    }

    this.history.push({ role: 'user', content: userText });
    this.trim();

    this.aborter = new AbortController();
    let full = '';
    let pending = '';
    let sentenceIndex = 0;

    const emit = (chunk: string) => {
      full += chunk;
      pending += chunk;
      events.onText(full);
      const [sentences, rest] = takeCompleteSentences(pending);
      pending = rest;
      for (const sentence of sentences) events.onSentence(sentence, sentenceIndex++);
    };

    try {
      // 서버측 도구가 반복 한도에 걸리면 pause_turn 으로 멈춘다.
      // 그때는 받은 응답을 이력에 넣고 다시 요청해 이어가게 한다.
      let assistantBlocks: Anthropic.ContentBlockParam[] = [];
      for (let round = 0; round < 5; round += 1) {
        const stream = this.client.messages.stream(
          {
            model: MODEL,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: this.history,
            output_config: { effort: 'medium' },
            tools: [
              { type: 'web_search_20260209', name: 'web_search' },
              { type: 'web_fetch_20260209', name: 'web_fetch' },
            ],
          },
          { signal: this.aborter.signal },
        );

        stream.on('text', emit);
        stream.on('contentBlock', (block) => {
          if (block.type === 'server_tool_use') events.onToolUse(block.name);
        });

        const message = await stream.finalMessage();
        assistantBlocks = message.content as Anthropic.ContentBlockParam[];
        this.history.push({ role: 'assistant', content: assistantBlocks });

        if (message.stop_reason !== 'pause_turn') break;
        // 이어서 계속하라는 뜻. 사용자 메시지를 덧붙이지 않는다.
      }

      // 마지막 문장이 종결부호 없이 끝났으면 남은 것을 흘려보낸다.
      const tail = pending.trim();
      if (tail) events.onSentence(tail, sentenceIndex++);
    } catch (error) {
      const err = error as { name?: string; message?: string; status?: number };
      if (err.name === 'AbortError') return full;

      // 8.4절: 네트워크가 끊기면 음성으로 알린다.
      const message =
        err.status === 401
          ? 'API 키가 유효하지 않습니다.'
          : err.status === 429
            ? '요청이 너무 많습니다. 잠시 후 다시 시도하겠습니다.'
            : err.message?.includes('fetch') || err.name === 'APIConnectionError'
              ? '네트워크가 끊겼습니다.'
              : `응답을 받지 못했습니다: ${err.message ?? '알 수 없는 오류'}`;
      events.onError(message);
      // 실패한 턴은 이력에서 뺀다 — 다음 요청이 깨진 짝으로 시작하면 안 된다.
      this.history.pop();
      return full;
    } finally {
      this.aborter = null;
    }

    return full;
  }

  /**
   * 8.2절: 자르는 지점은 도구 호출 짝이 깨지지 않는 경계여야 한다.
   * tool_use 가 담긴 assistant 메시지와 그 결과는 붙어 있어야 한다.
   */
  private trim(): void {
    if (this.history.length <= MAX_HISTORY_TURNS) return;
    let cut = this.history.length - MAX_HISTORY_TURNS;
    // user 메시지에서 시작하도록 앞으로 민다.
    while (cut < this.history.length && this.history[cut]?.role !== 'user') cut += 1;
    this.history = this.history.slice(cut);
  }
}
