import { homedir } from 'node:os';

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
/**
 * 골리앗이 쓸 수 있는 도구 (기획서 6.1절).
 *
 * 읽고 찾는 것까지만 연다. 되돌릴 수 없는 일을 하는 도구(Bash·Write·Edit)는
 * 넣지 않는다 — 상시 대기하는 마이크가 잘못 들은 말로 그것을 하면 안 된다.
 *
 * 실측으로 이름을 확인했다. 이 목록을 벗어난 도구는 모델의 맥락에서 아예
 * 사라진다 — "ls 를 실행해줘"라고 하면 "그 도구가 없습니다"라고 답한다.
 */
const READ_ONLY_TOOLS = ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'];

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

  /**
   * 밀려난 턴이 남길 출력의 수.
   *
   * 세션 스트림은 순서가 보장된다 — 앞 턴의 델타와 result 가 모두 지나간
   * 뒤에야 새 턴의 것이 온다. 그 전까지 오는 것은 전부 앞 턴의 잔여물이며,
   * 새 턴에 흘려 넣으면 새 턴이 앞 턴의 result 로 끝나 답이 사라진다.
   */
  private staleResults = 0;

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
    this.staleResults = 0;
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
        // 도구를 읽기·검색으로 좁혔으므로 승인 절차 없이 바로 실행한다.
        // 음성 대화 중에 승인 창이 뜨면 답할 방법이 없어 턴이 멈춘다.
        permissionMode: 'bypassPermissions',
        // 프로젝트의 CLAUDE.md 나 설정을 끌어오지 않는다. 골리앗은
        // 코딩 에이전트가 아니라 비서다.
        settingSources: [],
        // **실제 제한은 tools 다.** allowedTools 는 "물어보지 않고 실행할 것"
        // 목록일 뿐이라, 예전의 allowedTools: [] 는 아무것도 막지 못했다 —
        // bypassPermissions 와 합쳐져 Bash 까지 승인 없이 돌고 있었다(실측 확인).
        //
        // 상시 대기하는 마이크가 잘못 들은 말로 무엇을 실행해서는 안 된다.
        // Whisper 는 환각을 낸다(기획서 8.5절). 되돌릴 수 없는 일을 하는 도구는
        // 넣지 않는다 — Bash·Write·Edit 가 여기 없는 이유다.
        tools: READ_ONLY_TOOLS,
        allowedTools: READ_ONLY_TOOLS,
        // 파일을 물어보면 홈에서 찾는다. 앱을 어디서 띄웠든 "바탕화면의 저 파일"이
        // 통해야 한다 — 기본값은 프로세스의 실행 위치라 프로젝트 폴더가 된다.
        cwd: homedir(),
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
      if (this.staleResults > 0) {
        // 밀려난 턴의 잔여물. result 까지 삼키고 나면 새 턴이 흐른다.
        if (message.type === 'result') this.staleResults -= 1;
        continue;
      }
      const turn = this.turn;
      if (!turn) continue;

      if (message.type === 'stream_event') {
        // 토큰 단위 델타. 이것을 읽어야 진짜 스트리밍이다.
        // assistant 메시지만 읽으면 응답이 통째로 한 번에 와서, 첫 문장까지
        // 걸리는 시간이 전체 응답 시간과 같아진다 (실측 4913ms vs 4947ms).
        const event = message.event;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          this.emit(turn, event.delta.text);
        }
      } else if (message.type === 'assistant') {
        // 완성된 메시지. 텍스트는 이미 델타로 받았으므로 도구만 본다.
        for (const block of message.message.content) {
          if (block.type === 'tool_use') turn.events.onToolUse(block.name);
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
    const displaced = this.turn;
    if (displaced) {
      // 앞 턴이 아직 끝나지 않았다 (사용자가 새 명령을 내린 것).
      // **여기서 반드시 매듭지어야 한다.** 그러지 않으면 앞 턴의 await 가
      // 영원히 걸린 채 남는다.
      displaced.aborted = true;
      this.turn = null;
      this.staleResults += 1;
      void this.session?.interrupt().catch(() => {
        /* 이미 끝났으면 무시 */
      });
      displaced.finish(displaced.full);
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
