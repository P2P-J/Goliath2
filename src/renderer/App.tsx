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
  working: '작업 중',
  speaking: '말하는 중',
};

/** 4.2절: 시각적 중심은 상태 오브. */
const ORB_COLOR: Record<GoliathState, string> = {
  inactive: '#2a2f36',
  idle: '#3d4b5c',
  booting: '#4a7fb5',
  listening: '#4fa3d1',
  transcribing: '#6b8fd4',
  working: '#c9a227',
  speaking: '#4fd1a3',
};

export function App() {
  const [state, setState] = useState<GoliathState>('inactive');
  const [log, setLog] = useState<string[]>([]);
  const board = useRef<SoundBoard>(new SoundBoard());

  useEffect(() => {
    const sb = board.current;

    void window.goliath.getState().then(setState);

    const offState = window.goliath.onStateChanged((next) => {
      setState(next);
      // 3.4절 덕킹. 음악 플레이어는 M4 에서 붙는다 — 지금은 목표 볼륨만 기록.
      setLog((prev) => [`상태 → ${LABEL[next]} (음악 ${DUCK_LEVELS[next] * 100}%)`, ...prev].slice(0, 40));
    });

    const offSound = window.goliath.onPlaySound((sound: SoundEvent) => {
      sb.play(sound);
      setLog((prev) => [`효과음: ${sound}`, ...prev].slice(0, 40));
    });

    const offTurn = window.goliath.onTurnUpdated((turn) => {
      setLog((prev) => [JSON.stringify(turn), ...prev].slice(0, 40));
    });

    return () => {
      offState();
      offSound();
      offTurn();
      sb.dispose();
    };
  }, []);

  return (
    <div style={styles.root}>
      <aside style={styles.sidebar}>
        <div style={styles.brand}>골리앗</div>
        <nav style={styles.nav}>
          {['대화', '재생목록', '설정'].map((item) => (
            <div key={item} style={styles.navItem}>
              {item}
            </div>
          ))}
        </nav>
        <button style={styles.button} onClick={() => window.goliath.command('toggle-active')}>
          {state === 'inactive' ? '인식 켜기' : '인식 끄기'}
        </button>
      </aside>

      <main style={styles.main}>
        <div
          style={{
            ...styles.orb,
            background: `radial-gradient(circle at 35% 30%, ${ORB_COLOR[state]}, #0b0d10 72%)`,
            boxShadow: `0 0 90px ${ORB_COLOR[state]}55`,
          }}
        />
        <div style={styles.state}>{LABEL[state]}</div>

        <div style={styles.log}>
          {log.length === 0 ? (
            <div style={styles.empty}>이벤트를 기다리는 중…</div>
          ) : (
            log.map((line, i) => (
              <div key={`${i}-${line}`} style={styles.logLine}>
                {line}
              </div>
            ))
          )}
        </div>
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'grid',
    gridTemplateColumns: '200px 1fr',
    height: '100vh',
    margin: 0,
    background: '#0b0d10',
    color: '#e6e9ee',
    font: '13px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif',
  },
  sidebar: {
    borderRight: '1px solid #1a1f26',
    padding: '46px 14px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
  },
  brand: { fontSize: 15, fontWeight: 600, letterSpacing: '0.04em' },
  nav: { display: 'flex', flexDirection: 'column', gap: 2 },
  navItem: { padding: '7px 10px', borderRadius: 6, color: '#8b95a3', cursor: 'default' },
  button: {
    marginTop: 'auto',
    padding: '9px 12px',
    borderRadius: 7,
    border: '1px solid #232a33',
    background: '#141920',
    color: '#e6e9ee',
    cursor: 'pointer',
    font: 'inherit',
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '56px 32px 24px',
    overflow: 'hidden',
  },
  orb: {
    width: 168,
    height: 168,
    borderRadius: '50%',
    transition: 'background 480ms ease, box-shadow 480ms ease',
  },
  state: { marginTop: 22, fontSize: 15, letterSpacing: '0.06em', color: '#aab4c2' },
  log: {
    marginTop: 34,
    width: '100%',
    maxWidth: 620,
    flex: 1,
    overflowY: 'auto',
    borderTop: '1px solid #1a1f26',
    paddingTop: 14,
  },
  logLine: {
    padding: '3px 0',
    color: '#7f8a99',
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    fontSize: 11.5,
  },
  empty: { color: '#4b5563', fontStyle: 'italic' },
};
