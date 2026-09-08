import pretendardUrl from 'pretendard/dist/web/variable/woff2/PretendardVariable.woff2?url';

/**
 * 디자인 토큰 (시안 골리앗 Goliath.dc.html).
 *
 * CSS 변수로 깔고 화면 조각은 var(--accent) 처럼 쓴다. 테마를 바꾸는 것이
 * :root 의 data-theme 하나를 바꾸는 일이 되어, React 를 다시 그리지 않아도
 * 색이 따라온다.
 *
 * 시안의 --desk 와 --shadow 는 뺐다. 창을 띄워 보여주려고 만든 바탕이고,
 * 실제로는 창 자체가 그 카드다 — 모서리와 그림자는 macOS 가 그린다.
 */

export type ThemeName = 'light' | 'dark';

const LIGHT = {
  accent: '#2f6df6',
  bg: '#ffffff',
  panel: '#f6f7f9',
  card: '#ffffff',
  text: '#0f1b3d',
  muted: '#6f7789',
  line: '#e9eaef',
  bubble: '#f2f3f6',
  soft: '#ecf2ff',
} as const;

const DARK: Record<keyof typeof LIGHT, string> = {
  accent: '#2f6df6',
  bg: '#14181f',
  panel: '#0f1319',
  card: '#1a1f28',
  text: '#e9ecf3',
  muted: '#98a1b2',
  line: '#262c37',
  bubble: '#212734',
  soft: '#1a2436',
};

const vars = (tokens: Record<string, string>): string =>
  Object.entries(tokens)
    .map(([key, value]) => `--${key}: ${value};`)
    .join(' ');

/** 시안에 없는 색. 오류 표시에만 쓴다. */
const EXTRA_LIGHT = { danger: '#c0392b', dangerBg: '#fdecea' };
const EXTRA_DARK = { danger: '#e0777b', dangerBg: '#2a1a1c' };

const STYLE_ID = 'goliath-theme';

/**
 * 토큰·글꼴·keyframes 를 문서에 한 번 깐다. main.tsx 가 부른다.
 *
 * 글꼴은 CDN 이 아니라 npm 패키지에서 온다. Vite 가 자산으로 내보내므로
 * CSP 를 외부 호스트로 넓히지 않아도 되고 인터넷이 없어도 뜬다.
 */
export function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
@font-face {
  font-family: 'Pretendard Variable';
  src: url('${pretendardUrl}') format('woff2-variations');
  font-weight: 45 920;
  font-style: normal;
  font-display: swap;
}
:root { ${vars({ ...LIGHT, ...EXTRA_LIGHT })} }
:root[data-theme="dark"] { ${vars({ ...DARK, ...EXTRA_DARK })} }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: 'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont,
    'Apple SD Gothic Neo', sans-serif;
  -webkit-font-smoothing: antialiased;
}
input[type="range"] { accent-color: var(--accent); }
@keyframes wv { 0%, 100% { transform: scaleY(.28); } 50% { transform: scaleY(1); } }
@keyframes fadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
`;
  document.head.appendChild(style);
}

const KEY = 'goliath:theme';

/** 저장된 테마. 없으면 시안의 기본값인 라이트. */
export function loadTheme(): ThemeName {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    // 사생활 보호 모드 등에서 막힐 수 있다. 기본값으로 간다.
    return 'light';
  }
}

/** 테마를 문서에 반영하고 기억한다. */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // 기억하지 못해도 이번 실행 동안은 동작해야 한다.
  }
}
