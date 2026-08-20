import type { MusicControl } from '@shared/protocol';

/**
 * 음성으로 오는 음악 조작을 뇌를 거치지 않고 바로 처리한다 (기획서 9절).
 *
 * "다음 곡" 을 Claude 에게 물어볼 이유가 없다. 왕복에 3초가 걸리고, 답도
 * 뻔하다. 여기서 즉시 처리하면 말이 끝나자마자 곡이 바뀐다.
 *
 * 확신이 서는 것만 가로챈다. 애매하면 뇌로 넘긴다 — 잘못 가로채면 사용자가
 * 한 말이 통째로 사라지는데, 그게 3초 기다리는 것보다 나쁘다.
 */

interface Rule {
  control: MusicControl;
  /** 이 중 하나라도 들어맞으면 잡는다. 공백을 지운 문자열에 대고 본다. */
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    control: { type: 'next' },
    patterns: [/^(음악|노래|곡)?다음(곡|노래|음악)?(틀어|재생|해|줘|주세요)*$/],
  },
  {
    control: { type: 'previous' },
    patterns: [/^(음악|노래|곡)?(이전|앞)(곡|노래|음악)?(틀어|재생|해|줘|주세요)*$/],
  },
  {
    control: { type: 'pause' },
    patterns: [
      /^(음악|노래|곡)(을|를)?(잠깐|잠시)?(멈춰|정지|스톱|중지|꺼|끄고|끄기)(줘|주세요)?$/,
      /^(잠깐|잠시)?(멈춰|정지)(줘|주세요)?$/,
    ],
  },
  {
    control: { type: 'play' },
    patterns: [
      /^(음악|노래)(을|를)?(다시|계속)?(틀어|재생|켜|시작)(줘|주세요|해줘)?$/,
      /^(음악|노래)(틀어|재생|켜|시작)(줘|주세요)?$/,
    ],
  },
  {
    control: { type: 'volume', value: 0.35 },
    patterns: [/^(음악|노래|소리|볼륨)(을|를)?(좀|조금)?(줄여|낮춰|작게)(줘|주세요)?$/],
  },
  {
    control: { type: 'volume', value: 0.9 },
    patterns: [/^(음악|노래|소리|볼륨)(을|를)?(좀|조금)?(키워|올려|높여|크게)(줘|주세요)?$/],
  },
];

/**
 * 발화가 음악 조작이면 그 명령을, 아니면 null 을 돌려준다.
 *
 * @param text 인식된 발화. 문장부호와 공백은 여기서 정리한다.
 */
export function matchMusicCommand(text: string): MusicControl | null {
  const squeezed = text.replace(/[\s.,!?~…'"]/g, '');
  if (!squeezed || squeezed.length > 20) return null; // 긴 문장은 명령이 아니다

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(squeezed)) return rule.control;
    }
  }
  return null;
}

/** 조작을 처리했을 때 골리앗이 짧게 답할 말. 없으면 조용히 넘어간다. */
export function acknowledge(control: MusicControl): string | null {
  switch (control.type) {
    case 'next':
      return '다음 곡입니다.';
    case 'previous':
      return '이전 곡입니다.';
    case 'pause':
      return '음악을 멈췄습니다.';
    case 'play':
      return '음악을 재생합니다.';
    case 'volume':
      return control.value < 0.5 ? '소리를 줄였습니다.' : '소리를 키웠습니다.';
    default:
      return null;
  }
}
