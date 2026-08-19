/**
 * 골리앗 프로세스 경계 프로토콜.
 *
 * 기획서 10절 "변경 불가 원칙":
 *   1. 오디오는 프로세스 경계를 넘지 않는다. 넘는 것은 짧은 텍스트 JSON뿐이다.
 *      → 마이크 입력과 TTS 출력은 전부 음성 엔진(Python) 안에서 처리한다.
 *        메인 프로세스는 "말해라"라는 명령과 "말이 끝났다"는 통보만 주고받는다.
 *   2. 음악은 렌더러가 재생한다. 덕킹이 UI 상태와 동기화되어야 하므로,
 *      메인은 엔진 이벤트를 렌더러로 그대로 중계한다.
 *   3. 음성 엔진은 교체 가능한 부품이다. 수퍼토닉을 다른 TTS로 갈아끼울 때
 *      이 파일이 바뀌면 안 된다.
 *
 * 전송 방식: 엔진의 stdin/stdout에 줄 단위 JSON (UTF-8, 한 줄 = 한 메시지).
 * 엔진의 stderr는 로그 전용이며 파싱하지 않는다.
 *
 * 이 파일을 수정하면 engine/goliath_engine/protocol.py 도 함께 수정하고
 * PROTOCOL_VERSION 을 올려야 한다. 불일치는 앱 시작 시 감지된다.
 */

export const PROTOCOL_VERSION = 3;

// ---------------------------------------------------------------------------
// 상태 (기획서 2.1절 상태 전이)
// ---------------------------------------------------------------------------

/**
 * 비활성  : 인식 완전 정지. 마이크 스트림을 닫고 모델을 해제한다 (2.4절).
 * 대기    : 웨이크워드만 듣는다.
 * 부팅    : "Goliath online" 최초 1회 (4.4절).
 * 듣는중  : 발화 수집 중.
 * 인식중  : Whisper 추론 중.
 * 작업중  : Claude 호출 / 도구 실행 중.
 * 말하는중: TTS 재생 중. 끼어들기 감지 대상 (2.3절).
 */
export type GoliathState =
  | 'inactive'
  | 'idle'
  | 'booting'
  | 'listening'
  | 'transcribing'
  | 'working'
  | 'speaking';

/** 음향 캐릭터 프리셋. engine/goliath_engine/audio_fx.py 와 짝을 이룬다. */
export type VoicePreset = 'none' | 'jarvis' | 'goliath';

/**
 * 기본 음성 설정 — M1 보이스 + 자비스 프리셋.
 * 10종을 직접 청취해 확정했다 (bench/make_voice_samples.py).
 */
export const DEFAULT_VOICE_CONFIG = {
  voice: 'M1',
  preset: 'jarvis',
  speed: 1.35,
  pitchFactor: 1.07,
  fxIntensity: 1.0,
  steps: 8,
} as const;

// ---------------------------------------------------------------------------
// 메인 → 엔진 (명령)
// ---------------------------------------------------------------------------

export type EngineCommand =
  /** 웨이크워드 대기 시작. 마이크 스트림을 연다. */
  | { type: 'wake.enable' }
  /** 웨이크워드 대기 중지. 마이크 스트림을 닫는다 (메뉴바 주황 점이 사라져야 한다). */
  | { type: 'wake.disable' }

  /** 발화 수집 시작. 웨이크워드 감지 후, 또는 전역 단축키로 직접 호출. */
  | { type: 'listen.start' }
  /** 발화 수집 강제 종료. 침묵 1.2초로 자동 종료되므로 보통은 불필요. */
  | { type: 'listen.stop' }

  /**
   * 말하기. text 는 TTS 후처리 필터를 이미 통과한 문장이다 (3.3절 이중 방어).
   * 필터는 메인 프로세스가 담당한다 — 엔진은 받은 걸 그대로 읽는다.
   */
  | {
      type: 'speak';
      id: string;
      text: string;
      /**
       * true 면 앞 발화를 끊지 않고 뒤에 이어 말한다.
       *
       * Claude 응답을 스트리밍으로 받으면서 문장이 완성될 때마다 보내려면
       * 필요하다. 기본값(false)은 앞 발화를 밀어내는 '교체' 의미다 —
       * 사용자가 새 명령을 내렸을 때가 그 경우다.
       */
      queue?: boolean;
    }
  /** 말하기 중단. 끼어들기(2.3절)와 사용자 취소 양쪽에서 쓴다. */
  | { type: 'speak.cancel'; id: string }

  /** 모델 즉시 해제 (7.1절: 유휴 15분, 인식 비활성화 시). */
  | { type: 'models.release' }

  | { type: 'config.set'; config: Partial<EngineConfig> }
  /** 계측 스냅샷 요청 (7.2절 설정 화면의 실시간 표시용). */
  | { type: 'metrics.request' }

  | { type: 'shutdown' };

export interface EngineConfig {
  /** 5.1절. 예: 'large-v3', 'large-v3-turbo', 'medium', 'small' */
  whisperModel: string;
  /** 5.2절. 언어 고정 — 자동 감지는 시도하지 않는다. */
  language: string;
  /** 5.2절. 개발 용어 힌트(initial prompt). 쓰면서 늘려간다. */
  vocabularyHints: string[];
  /** 5.1절. 학습 전까지 'hey_jarvis', 이후 'goliath_online'. 모델 파일만 교체. */
  wakeWordModel: string;
  /** 웨이크워드 민감도 (리스크: 오탐). 0.0~1.0 */
  wakeWordThreshold: number;
  /**
   * 2.3절 끼어들기. 에어팟에서만 기본 켬 — 내장 스피커는 자기 목소리를 되듣는다.
   * null 이면 출력 장치에 따라 자동 판단한다.
   */
  interruptEnabled: boolean | null;
  /**
   * 입(TTS) 설정 — 수퍼토닉 기준.
   *
   * 수퍼토닉에는 음높이 파라미터가 없어, 합성 단계에서 speed 에 pitchFactor 를
   * 곱해 두고 후처리에서 되돌린다 — 길이는 그대로, 음높이만 내려간다.
   * 그래서 speed 와 pitchFactor 는 서로 독립적으로 조절된다.
   */
  /** 기본 보이스 10종: M1~M5(남성), F1~F5(여성). */
  voice: string;
  /** 캐릭터 프리셋. 발화 단위로 바꿀 수 있다 (부팅 멘트만 goliath 등). */
  preset: VoicePreset;
  /** 말 속도. 수퍼토닉 기본 1.05, 대화용 1.35. 범위 0.7~2.0. */
  speed: number;
  /** 음높이 하강 배율. 1.0 = 원본. 범위 1.0~1.3. */
  pitchFactor: number;
  /** 효과 강도. 0.0 = 무효과, 1.0 = 프리셋 기본값. */
  fxIntensity: number;
  /** 품질 스텝 5~12. 높을수록 또렷하고 느리다. */
  steps: number;
  /** 5.4절 완화 옵션. 켜면 대기 중에는 내장 마이크를 쓴다 (전환에 0.5~1초). */
  wakeOnBuiltinMicOnly: boolean;
}

// ---------------------------------------------------------------------------
// 엔진 → 메인 (이벤트)
// ---------------------------------------------------------------------------

export type EngineEvent =
  /** 기동 완료. 프로토콜 버전 불일치는 여기서 감지한다. */
  | { type: 'ready'; protocolVersion: number; engineVersion: string }

  /** 웨이크워드 감지. */
  | { type: 'wake'; confidence: number }

  /**
   * 발화 시작/종료 감지 (VAD). 두 용도가 있다:
   *   - 듣는중 상태에서: 침묵 판정으로 발화 종료
   *   - 말하는중 상태에서: 끼어들기 감지 (2.3절)
   */
  | { type: 'speech'; active: boolean }

  /**
   * 인식 결과. 5.3절 환각 방지를 통과한 것만 올라온다.
   * discarded 가 true 면 폐기 사유가 reason 에 담기고 text 는 비어 있다.
   */
  | {
      type: 'transcript';
      text: string;
      confidence: number;
      discarded: boolean;
      reason?: 'too_short' | 'silence' | 'blacklisted' | 'low_confidence';
      latencyMs: number;
    }

  /** TTS 첫 소리가 나기 시작함. 발화종료→첫소리 지연 측정의 종점 (M1 통과 조건). */
  | { type: 'speak.begin'; id: string; firstAudioLatencyMs: number }
  /** TTS 재생 종료. cancelled 면 끼어들기 등으로 중단된 것. */
  | { type: 'speak.end'; id: string; cancelled: boolean }

  /** 7.1절 모델 생명주기. 로딩 효과음 안내 트리거. */
  | { type: 'model'; which: 'stt' | 'tts'; loaded: boolean; loadMs?: number }

  /** 5.4절. 에어팟 착탈. 스트림 재시작 후 짧은 효과음으로 알린다. */
  | {
      type: 'device';
      input: string;
      output: string;
      outputIsBluetooth: boolean;
    }

  /** 7.3절 계측. */
  | { type: 'metrics'; rssMb: number; wakeCpuPercent: number; lastLatencyMs: number | null }

  /**
   * 복구 가능한 오류. 8.4절 네트워크 단절, TTS 실패(→맥 내장 음성 폴백) 등.
   * fatal 이면 엔진이 죽는 중이므로 메인이 재기동해야 한다.
   */
  | { type: 'error'; code: string; message: string; fatal: boolean };

// ---------------------------------------------------------------------------
// 메인 → 렌더러 (IPC). 원칙 2: 덕킹이 UI 상태와 동기화되어야 한다.
// ---------------------------------------------------------------------------

export const IPC = {
  /** 메인 → 렌더러: 상태 변화 브로드캐스트. 덕킹과 오브 애니메이션이 여기 붙는다. */
  stateChanged: 'goliath:state-changed',
  /** 메인 → 렌더러: 대화 턴 추가/갱신. */
  turnUpdated: 'goliath:turn-updated',
  /** 메인 → 렌더러: 효과음 재생 요청 (6절). 합성은 렌더러가 Web Audio로 한다. */
  playSound: 'goliath:play-sound',
  /** 렌더러 → 메인: 음악 재생 상태 통보 (덕킹 복귀 판단에 필요 — 3.4절). */
  musicState: 'goliath:music-state',
  /** 렌더러 → 메인: 사용자 조작 (토글, 설정 변경 등). */
  command: 'goliath:command',
} as const;

/** 6절 사운드 디자인. 렌더러가 Web Audio API로 직접 합성한다. */
export type SoundEvent =
  | 'boot'
  | 'wake'
  | 'processing'
  | 'complete'
  | 'error'
  | 'idle-return'
  | 'device-switch';

/** 3.4절 덕킹. 상태별 음악 볼륨. */
export const DUCK_LEVELS: Record<GoliathState, number> = {
  inactive: 1.0,
  idle: 1.0,
  booting: 0.2,
  listening: 0.2,
  transcribing: 0.2,
  working: 0.6,
  speaking: 0.2,
};

/** 2.2절 두 개의 타이머. 혼동하기 쉬우므로 상수로 못 박는다. */
export const TIMERS = {
  /** 청취 창: 답한 뒤 웨이크워드 없이 말을 걸 수 있는 시간. */
  listenWindowMs: 15_000,
  /** 대화 기억: 대기로 돌아간 뒤에도 맥락을 유지하는 시간. */
  conversationMemoryMs: 15 * 60_000,
  /** 발화 종료 판정 침묵 길이. */
  silenceMs: 1_200,
  /** 7.1절 모델 유휴 해제. */
  modelIdleReleaseMs: 15 * 60_000,
} as const;
