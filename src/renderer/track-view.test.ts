import { describe, expect, it } from 'vitest';

import { coverColor, formatDuration } from './track-view';

describe('formatDuration', () => {
  it('초를 분:초로 바꾼다', () => {
    expect(formatDuration(312)).toBe('5:12');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(9)).toBe('0:09');
  });

  // 이것이 이 함수가 있는 이유다. goliath-media 는 Content-Length 가 없으면
  // duration 을 Infinity 로 준다. 그대로 계산하면 화면에 NaN:NaN 이 뜬다.
  it('길이를 모르면 --:-- 를 준다', () => {
    expect(formatDuration(Infinity)).toBe('--:--');
    expect(formatDuration(NaN)).toBe('--:--');
    expect(formatDuration(0)).toBe('--:--');
  });
});

describe('coverColor', () => {
  it('같은 이름이면 늘 같은 색이다', () => {
    expect(coverColor('빗소리 낮은 방')).toBe(coverColor('빗소리 낮은 방'));
  });

  it('다른 이름이면 다른 색이다', () => {
    expect(coverColor('빗소리 낮은 방')).not.toBe(coverColor('새벽 피아노'));
  });

  it('시안과 같은 파스텔 범위 안에 있다', () => {
    const m = /^hsl\((\d+) 34% 90%\)$/.exec(coverColor('아무 곡'));
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(0);
    expect(Number(m![1])).toBeLessThan(360);
  });
});
