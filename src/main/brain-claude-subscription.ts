import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { SYSTEM_PROMPT, type Brain, type BrainEvents } from './brain';
import { takeCompleteSentences } from './speech-filter';

/**
 * 이미 내고 있는 클로드 구독을 뇌로 쓴다.
 *
 * Claude Agent SDK 는 Claude Code 의 자격증명(키체인)을 그대로 쓴다.
 * API 키를 따로 사지 않아도 된다. 개인용으로 쓰는 한 이것이 공식 경로다 —
 * 남에게 배포할 때는 API 과금이 필요하다.
 *
 * **세션을 유지하는 것이 핵심이다.** 호출마다 새로 띄우면 매번 프로세스
 * 기동 비용을 문다. 실측:
 *
 *   호출마다 새 세션   6~9초
 *   세션 유지          첫 턴 6.7초, 이후 약 3초
 *
 * 그래도 클로드 음성 모드(1~2초)보다 느리다. Agent SDK 가 Claude Code
 * 하니스(약 22k 토큰)를 매 턴 싣기 때문이며 줄일 수 없다. 문장 단위로
 * 말하기 시작하므로 체감은 그보다 짧다.
 */
export class ClaudeSubscriptionBrain implements Brain {
  readonly name = 'claude-subscription';

  private session: Query | null = null;

  /** 세션에 넣을 다음 발화. 한 번에 하나만 처리한다 (턴 기반). */
  private inbox: string[] = [];
  private inboxWaiter: (() => void) | null = null;
  private closed = false;

  /** 진행 중인 턴. 세션 출력이 여기로 흘러간다. */
  private turn: {
    events: BrainEvents;
    finish: (text: string) => void;
    full: string;
    pending: string;
    aborted: boolean;
  } | null = null;

  private readonly model: string;

  constructor(model = 'claude-sonnet-5') {
    // 실측상 모델을 바꿔도 지연이 크게 달라지지 않는다. 대화용으로는
    // sonnet 이 opus 보다 빠르면서 한국어 품질이 충분하다.
    this.model = model;
  }

  async connect(): Promise<boolean> {
    // Agent SDK 는 Claude Code 자격증명을 쓴다. 실제 가용 여부는 첫 턴에
    // 드러나므로 여기서는 모듈 로드만 확인한다.
    return typeof query === 'function';
  }

  reset(): void {
    // 세션을 새로 띄우면 맥락이 비워진다.
    void this.dispose();
  }

  abort(): void {
    const turn = this.turn;
    if (!turn) return;
    turn.aborted = true;
    void this.session?.interrupt().catch(() => {
      /* 이미 끝났으면 무시 */
    });
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.inboxWaiter?.();
    try {
      await this.session?.return(undefined);
    } catch {
      /* 이미 닫혔으면 무시 */
    }
    this.session = null;
    this.closed = false;
    this.inbox = [];
  }

  // -- 입력 스트림 -------------------------------------------------------

  private async takeNext(): Promise<string | null> {
    for (;;) {
      const next = this.inbox.shift();
      if (next !== undefined) return next;
      if (this.closed) return null;
      await new Promise<void>((resolve) => {
        this.inboxWaiter = resolve;
      });
      this.inboxWaiter = null;
    }
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const text = await this.takeNext();
      if (text === null) return;
      yield {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        session_id: 'goliath',
      } as SDKUserMessage;
    }
  }

  // -- 세션 --------------------------------------------------------------

  private ensureSession(): void {
    if (this.session) return;

    this.session = query({
      prompt: this.input(),
      options: {
        model: this.model,
        systemPrompt: SYSTEM_PROMPT,
        permissionMode: 'bypassPermissions',
        // 프로젝트의 CLAUDE.md 나 설정을 끌어오지 않는다. 골리앗은
        // 코딩 에이전트가 아니라 비서다.
        settingSources: [],
        // 도구는 M6 에서 붙인다. 지금은 대화만.
        allowedTools: [],
        includePartialMessages: true,
        // 실측 (sonnet-5, 따뜻한 턴 기준 첫 문장까지)
        //   기본(adaptive)        4531ms
        //   thinking disabled     2841ms   ← 채택
        //   effort low            4096ms
        //   disabled + effort low 3400ms
        //
        // 도구를 붙이는 M6 에서 다시 봐야 한다 — 생각을 끄면 도구를 덜
        // 부르고, 도구 호출을 본문 글자로 흘리는 경우가 보고돼 있다.
        thinking: { type: 'disabled' },
      },
    });

    void this.runPump().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.turn?.events.onError(`뇌 세션이 끊겼습니다: ${message}`);
      this.turn?.finish(this.turn.full);
      this.turn = null;
      this.session = null;
    });
  }

  private async runPump(): Promise<void> {
    if (!this.session) return;

    for await (const message of this.session) {
      const turn = this.turn;
      if (!turn) continue;

      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') this.emit(turn, block.text);
          else if (block.type === 'tool_use') turn.events.onToolUse(block.name);
        }
      } else if (message.type === 'result') {
        // 종결부호 없이 끝난 마지막 조각을 흘려보낸다.
        const tail = turn.pending.trim();
        if (tail && !turn.aborted) turn.events.onSentence(tail);
        turn.pending = '';
        this.turn = null;
        turn.finish(turn.full);
      }
    }
  }

  private emit(turn: NonNullable<typeof this.turn>, chunk: string): void {
    if (turn.aborted) return;
    turn.full += chunk;
    turn.pending += chunk;
    turn.events.onText(turn.full);
    const [sentences, rest] = takeCompleteSentences(turn.pending);
    turn.pending = rest;
    for (const sentence of sentences) turn.events.onSentence(sentence);
  }

  // -- 한 턴 -------------------------------------------------------------

  async ask(userText: string, events: BrainEvents): Promise<string> {
    if (this.turn) {
      // 앞 턴이 아직 끝나지 않았다. 밀어낸다 (사용자가 새 명령을 내린 것).
      this.abort();
    }

    this.ensureSession();

    return new Promise<string>((resolve) => {
      this.turn = {
        events,
        finish: resolve,
        full: '',
        pending: '',
        aborted: false,
      };
      this.inbox.push(userText);
      this.inboxWaiter?.();
    });
  }
}
