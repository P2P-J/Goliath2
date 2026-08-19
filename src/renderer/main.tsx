import { createRoot } from 'react-dom/client';

import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root 를 찾을 수 없습니다');

document.body.style.margin = '0';

// 듣고 있을 때 상태 점이 맥동한다. 소리 대신 눈으로 알린다.
const style = document.createElement('style');
style.textContent = '@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }';
document.head.appendChild(style);
createRoot(root).render(<App />);
