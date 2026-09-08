import { createRoot } from 'react-dom/client';

import { App } from './App';
import { applyTheme, installStyles, loadTheme } from './theme';

const root = document.getElementById('root');
if (!root) throw new Error('#root 를 찾을 수 없습니다');

// React 가 그리기 전에 토큰과 글꼴을 깐다. 나중에 깔면 첫 프레임이 흰 화면이다.
installStyles();
applyTheme(loadTheme());

createRoot(root).render(<App />);
