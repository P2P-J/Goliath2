/**
 * 곡 카드 표시용 순수 함수.
 *
 * 음악 파일에는 앨범 그림도 분류도 없다. 있는 것은 파일 이름과 길이뿐이라
 * 화면에 쓸 것을 여기서 만들어 낸다. DOM 을 건드리지 않으므로 테스트가 쉽다.
 */

/**
 * 파일 이름에서 커버 색을 만든다.
 *
 * 채도와 명도를 고정하고 색상만 바꾼다 — 시안의 커버(#dce6fb, #f0e7dc …)가
 * 전부 옅은 파스텔이라 그 범위를 벗어나면 격자가 시끄러워진다.
 * 라이트·다크 어느 쪽에서도 같은 색을 쓴다. 시안의 다크 화면도 그렇다.
 */
export function coverColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 34% 90%)`;
}

/**
 * 초를 분:초로. 길이를 모르면 --:-- .
 *
 * goliath-media 응답에 Content-Length 가 없으면 duration 이 Infinity 로 온다.
 * 그대로 계산하면 NaN:NaN 이 화면에 뜬다.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
