import { EventEmitter } from 'node:events';

import { TIMERS, type GoliathState } from '@shared/protocol';

/**
 * 대화 상태 기계 (기획서 2.1절).
 *
 * 골격 단계에서는 전이 규칙과 2.2절의 "두 개의 타이머"만 구현한다.
 * 실제 오디오·Claude 호출은 M1~M2 에서 붙는다.
 *
 * 2.2절이 특히 헷갈리기 쉬우므로 이 파일에서 명확히 분리한다:
 *   청취 창 (15초)  — 마이크가 열려 있는 시간. 지나면 대기로 복귀.
 *   대화 기억 (15분) — 맥락을 유지하는 시간. 지나면 새 대화.
 * 두 타이머는 서로 독립적이다. 청취 창이 닫혀도 기억은 살아 있다.
 */
export class ConversationState extends EventEmitter {
  private current: GoliathState = 'inactive';

  private listenWindow: NodeJS.Timeout | null = null;
  private memoryWindow: NodeJS.Timeout | null = null;
  private modelIdle: NodeJS.Timeout | null = null;

  /** 부팅 멘트는 앱 실행 후 한 번만 (4.4절). */
  private bootAnnounced = false;

  get state(): GoliathState {
    return this.current;
  }

  /** 대화 맥락이 아직 유효한가. false 면 다음 발화는 새 대화로 시작한다. */
  get hasMemory(): boolean {
    return this.memoryWindow !== null;
  }

  get needsBootAnnouncement(): boolean {
    return !this.bootAnnounced;
  }

  markBootAnnounced(): void {
    this.bootAnnounced = true;
  }

  transition(next: GoliathState): void {
    if (next === this.current) return;
    const prev = this.current;
    this.current = next;

    this.applyTimers(next);
    this.emit('change', next, prev);
  }

  /**
   * 상태별 타이머 관리.
   *
   * 2.2절 "타이머 정지 조건": 작업 대기 중이거나 말하는 중에는
   * 청취 창 타이머가 돌지 않는다 — 골리앗이 일하는 동안 창이 닫히면 안 된다.
   * 7.1절 유휴 판정도 같다: 마지막 음성 출력 종료 시점부터 센다.
   */
  private applyTimers(state: GoliathState): void {
    switch (state) {
      case 'inactive':
        // 2.4절: 인식 비활성화 시 모델을 즉시 해제한다.
        this.clearAll();
        this.emit('releaseModels');
        break;

      case 'idle':
        this.stopListenWindow();
        this.startModelIdle();
        break;

      case 'listening':
        this.startListenWindow();
        this.stopModelIdle();
        this.touchMemory();
        break;

      case 'booting':
      case 'transcribing':
      case 'working':
      case 'speaking':
        // 타이머 정지 구간. 청취 창도 유휴 타이머도 돌지 않는다.
        this.stopListenWindow();
        this.stopModelIdle();
        this.touchMemory();
        break;
    }
  }

  // -- 청취 창 (15초) ----------------------------------------------------

  /** 답을 마친 직후 호출한다. 웨이크워드 없이 이어 말할 수 있는 창을 연다. */
  openListenWindow(): void {
    this.transition('listening');
  }

  private startListenWindow(): void {
    this.stopListenWindow();
    this.listenWindow = setTimeout(() => {
      this.listenWindow = null;
      this.emit('listenWindowExpired');
      this.transition('idle');
    }, TIMERS.listenWindowMs);
  }

  private stopListenWindow(): void {
    if (this.listenWindow) {
      clearTimeout(this.listenWindow);
      this.listenWindow = null;
    }
  }

  // -- 대화 기억 (15분) --------------------------------------------------

  /** 대화가 일어날 때마다 기억 시계를 되감는다. */
  private touchMemory(): void {
    if (this.memoryWindow) clearTimeout(this.memoryWindow);
    this.memoryWindow = setTimeout(() => {
      this.memoryWindow = null;
      this.emit('memoryExpired');
    }, TIMERS.conversationMemoryMs);
  }

  // -- 모델 유휴 해제 (15분, 7.1절) --------------------------------------

  private startModelIdle(): void {
    this.stopModelIdle();
    this.modelIdle = setTimeout(() => {
      this.modelIdle = null;
      this.emit('releaseModels');
    }, TIMERS.modelIdleReleaseMs);
  }

  private stopModelIdle(): void {
    if (this.modelIdle) {
      clearTimeout(this.modelIdle);
      this.modelIdle = null;
    }
  }

  private clearAll(): void {
    this.stopListenWindow();
    this.stopModelIdle();
    if (this.memoryWindow) {
      clearTimeout(this.memoryWindow);
      this.memoryWindow = null;
    }
  }

  dispose(): void {
    this.clearAll();
    this.removeAllListeners();
  }
}
