import { useEffect, useRef, useState } from 'react';

import { DUCK_LEVELS, type GoliathState, type SoundEvent } from '@shared/protocol';
import { SoundBoard } from './sounds';
import type { GoliathApi } from '../preload';

declare global {
  interface Window {
    goliath: GoliathApi;
  }
}

const LABEL: Record<GoliathState, string> = {
  inactive: '비활성',
  idle: '대기',
  booting: '부팅',
  listening: '듣는 중',
  transcribing: '인식 중',
  working: '생각 중',
  speaking: '말하는 중',
};

/** 7.4절: 시각적 중심은 상태 오브. */
const ORB: Record<GoliathState, string> = {
  inactive: '#2a2f36',
  idle: '#3d4b5c',
  booting: '#4a7fb5',
  listening: '#4fa3d1',
  transcribing: '#6b8fd4',
  working: '#c9a227',
  speaking: '#4fd1a3',
};

type Role = 'user' | 'assistant' | 'tool' | 'error';
interface Turn {
  role: Role;
  text: string;
  done: boolean;
}
interface Update {
  role: Role;
  text: string;
  done: boolean;
}

const TOOL_LABEL: Record<string, string> = {
  web_search: '웹을 검색하고 있습니다',
  web_fetch: '문서를 읽고 있습니다',
  code_execution: '코드를 실행하고 있습니다',
};

export function App() {
  const [state, setState] = useState<GoliathState>('inactive');
  const [turns, setTurns] = useState<Turn[]>([]);
  const board = useRef<SoundBoard>(new SoundBoard());
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sb = board.current;
    void window.goliath.getState().then(setState);

    const offState = window.goliath.onStateChanged(setState);
    const offSound = window.goliath.onPlaySound((s: SoundEvent) => sb.play(s));

    const offTurn = window.goliath.onTurnUpdated((raw) => {
      const u = raw as Update;
      if (!u || typeof u.role !== 'string') return;

      setTurns((prev) => {
        // 빈 텍스트 + done 은 "이 턴 끝" 신호일 뿐이다.
        if (u.role === 'assistant' && u.done && !u.text) {
          return prev.map((t, i) => (i === prev.length - 1 ? { ...t, done: true } : t));
        }
        const last = prev[prev.length - 1];
        // 스트리밍 중인 같은 역할이면 덮어쓴다.
        if (last && last.role === u.role && !last.done) {
          return [...prev.slice(0, -1), { role: u.role, text: u.text, done: u.done }];
        }
        return [...prev, { role: u.role, text: u.text, done: u.done }];
      });
    });

    return () => {
      offState();
      offSound();
      offTurn();
      sb.dispose();
    };
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  return (
    <div style={S.root}>
      <aside style={S.sidebar}>
        <div style={S.brand}>골리앗</div>
        <nav style={S.nav}>
          {['대화', '재생목록', '설정'].map((item, i) => (
            <div key={item} style={{ ...S.navItem, ...(i === 0 ? S.navActive : null) }}>
              {item}
            </div>
          ))}
        </nav>
        <div style={S.orbWrap}>
          <div
            style={{
              ...S.orb,
              background: `radial-gradient(circle at 35% 30%, ${ORB[state]}, #0b0d10 72%)`,
              boxShadow: `0 0 54px ${ORB[state]}44`,
            }}
          />
          <div style={S.orbLabel}>{LABEL[state]}</div>
          <div style={S.duck}>음악 {Math.round(DUCK_LEVELS[state] * 100)}%</div>
        </div>
        <button style={S.button} onClick={() => window.goliath.command('toggle-active')}>
          {state === 'inactive' ? '인식 켜기' : '인식 끄기'}
        </button>
      </aside>

      <main style={S.main}>
        {turns.length === 0 ? (
          <div style={S.empty}>
            <div style={S.emptyTitle}>골리앗 온라인</div>
            <div style={S.emptyHint}>말을 걸어보세요. 대화가 여기에 쌓입니다.</div>
          </div>
        ) : (
          <div style={S.stream}>
            {turns.map((t, i) => (
              <Bubble key={i} turn={t} />
            ))}
            <div ref={bottom} />
          </div>
        )}
      </main>
    </div>
  );
}

function Bubble({ turn }: { turn: Turn }) {
  if (turn.role === 'tool') {
    return <div style={S.tool}>{TOOL_LABEL[turn.text] ?? turn.text}…</div>;
  }
  if (turn.role === 'error') {
    return <div style={S.error}>{turn.text}</div>;
  }
  const mine = turn.role === 'user';
  return (
    <div style={{ ...S.row, justifyContent: mine ? 'flex-end' : 'flex-start' }}>
      <div style={{ ...S.bubble, ...(mine ? S.mine : S.theirs) }}>
        {turn.text}
        {!turn.done && !mine ? <span style={S.caret}>▌</span> : null}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'grid',
    gridTemplateColumns: '212px 1fr',
    height: '100vh',
    margin: 0,
    background: '#0b0d10',
    color: '#e6e9ee',
    font: '14px/1.7 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif',
  },
  sidebar: {
    borderRight: '1px solid #1a1f26',
    padding: '46px 14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  brand: { fontSize: 15, fontWeight: 600, letterSpacing: '0.04em' },
  nav: { display: 'flex', flexDirection: 'column', gap: 2 },
  navItem: { padding: '7px 10px', borderRadius: 6, color: '#8b95a3', fontSize: 13 },
  navActive: { background: '#141920', color: '#e6e9ee' },
  orbWrap: { marginTop: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 },
  orb: { width: 92, height: 92, borderRadius: '50%', transition: 'all 480ms ease' },
  orbLabel: { fontSize: 13, color: '#aab4c2', letterSpacing: '0.04em' },
  duck: { fontSize: 11, color: '#4b5563' },
  button: {
    padding: '9px 12px',
    borderRadius: 7,
    border: '1px solid #232a33',
    background: '#141920',
    color: '#e6e9ee',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 13,
  },
  main: { overflowY: 'auto', padding: '46px 0 40px' },
  stream: { maxWidth: 720, margin: '0 auto', padding: '0 28px', display: 'flex', flexDirection: 'column', gap: 14 },
  row: { display: 'flex' },
  bubble: { maxWidth: '78%', padding: '10px 15px', borderRadius: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  mine: { background: '#1d2a3a', borderBottomRightRadius: 4 },
  theirs: { background: '#141920', border: '1px solid #1e242c', borderBottomLeftRadius: 4 },
  caret: { opacity: 0.5, marginLeft: 2 },
  tool: { alignSelf: 'center', fontSize: 12, color: '#c9a227', padding: '3px 0' },
  error: {
    alignSelf: 'center',
    fontSize: 13,
    color: '#e0777b',
    background: '#1c1416',
    border: '1px solid #33202a',
    borderRadius: 8,
    padding: '8px 14px',
  },
  empty: { height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyTitle: { fontSize: 18, letterSpacing: '0.08em', color: '#3d4b5c' },
  emptyHint: { fontSize: 13, color: '#39424e' },
};
