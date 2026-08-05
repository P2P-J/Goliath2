import { createRoot } from 'react-dom/client';

import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root 를 찾을 수 없습니다');

document.body.style.margin = '0';
createRoot(root).render(<App />);
