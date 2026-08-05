import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage } from 'electron';
import { resolve } from 'node:path';

import { IPC, type EngineEvent, type GoliathState } from '@shared/protocol';
import { VoiceEngine } from './engine';
import { ConversationState } from './state';
import { KEYS, getKey, migrateEnvFile } from './keychain';

/**
 * 골리앗 메인 프로세스.
 *
 * 4.1절: 메뉴바 상주. 깨어날 때 창을 띄우지 않는다 —
 *        개발 중에 창이 에디터 위로 튀어나오면 방해가 된다.
 * 4.3절: 시작 시 창 없이 메뉴바에만 나타난다.
 */

let tray: Tray | null = null;
let window: BrowserWindow | null = null;

const engine = new VoiceEngine();
const state = new ConversationState();

/** 메뉴바 아이콘이 표시하는 상태 (4.1절). */
const STATE_LABEL: Record<GoliathState, string> = {
  inactive: '비활성',
  idle: '대기',
  booting: '부팅',
  listening: '듣는 중',
  transcribing: '인식 중',
  working: '작업 중',
  speaking: '말하는 중',
};

const STATE_GLYPH: Record<GoliathState, string> = {
  inactive: '○',
  idle: '◍',
  booting: '◐',
  listening: '◉',
  transcribing: '◑',
  working: '◒',
  speaking: '◓',
};

// ---------------------------------------------------------------------------
// 창 — 명시적으로 열 때만 (4.1절)
// ---------------------------------------------------------------------------

function openWindow(): void {
  if (window) {
    window.show();
    window.focus();
    return;
  }

  window = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0d10',
    webPreferences: {
      // 메인/프리로드는 CJS 로 빌드된다 (Electron 메인 프로세스의 ESM 지원이
      // 네임드 임포트에서 깨지므로). 따라서 __dirname 을 쓴다.
      preload: resolve(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.on('ready-to-show', () => window?.show());
  window.on('closed', () => {
    window = null;
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(resolve(__dirname, '../renderer/index.html'));
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  window?.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// 메뉴바
// ---------------------------------------------------------------------------

function refreshTray(): void {
  if (!tray) return;
  const s = state.state;
  tray.setTitle(` ${STATE_GLYPH[s]}`);
  tray.setToolTip(`골리앗 — ${STATE_LABEL[s]}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `상태: ${STATE_LABEL[s]}`, enabled: false },
      { type: 'separator' },
      {
        // 2.4절 비활성 토글. 트레이와 전역 단축키 양쪽에서 즉시 전환.
        label: s === 'inactive' ? '인식 켜기' : '인식 끄기',
        click: () => toggleActive(),
      },
      { label: '창 열기', click: () => openWindow() },
      { type: 'separator' },
      { label: '종료', click: () => shutdown() },
    ]),
  );
}

function toggleActive(): void {
  if (state.state === 'inactive') {
    state.transition('idle');
    engine.send({ type: 'wake.enable' });
  } else {
    engine.send({ type: 'wake.disable' });
    state.transition('inactive');
  }
}

// ---------------------------------------------------------------------------
// 엔진 이벤트 → 상태 기계 + 렌더러
// ---------------------------------------------------------------------------

function onEngineEvent(event: EngineEvent): void {
  switch (event.type) {
    case 'ready':
      // 4.4절 부팅 멘트는 맥북을 켜고 앱이 처음 실행될 때 한 번만.
      if (state.needsBootAnnouncement) {
        state.markBootAnnounced();
        sendToRenderer(IPC.playSound, 'boot');
      }
      engine.send({ type: 'wake.enable' });
      state.transition('idle');
      break;

    case 'wake':
      sendToRenderer(IPC.playSound, 'wake');
      engine.send({ type: 'listen.start' });
      state.openListenWindow();
      break;

    case 'speech':
      // 말하는 중에 발화가 감지되면 끼어들기 (2.3절).
      if (event.active && state.state === 'speaking') {
        engine.send({ type: 'speak.cancel', id: 'current' });
      }
      break;

    case 'transcript':
      if (event.discarded) {
        // 5.3절 환각 방지에 걸린 것. 조용히 대기로 돌아간다.
        state.transition('idle');
        break;
      }
      state.transition('working');
      sendToRenderer(IPC.turnUpdated, { role: 'user', text: event.text });
      // TODO(M1): Claude API 호출 → TTS 후처리 필터(3.3절) → engine.send({type:'speak'})
      break;

    case 'speak.begin':
      state.transition('speaking');
      break;

    case 'speak.end':
      // 답을 마쳤으니 청취 창을 연다 (2.2절).
      state.openListenWindow();
      break;

    case 'device':
      // 5.4절: 장치 변경 시 짧은 효과음으로 알린다.
      sendToRenderer(IPC.playSound, 'device-switch');
      break;

    case 'error':
      sendToRenderer(IPC.playSound, 'error');
      console.error(`[engine:${event.code}] ${event.message}`);
      break;

    case 'model':
    case 'metrics':
      sendToRenderer(IPC.turnUpdated, event);
      break;
  }
}

// ---------------------------------------------------------------------------
// 기동
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  // 8.3절: .env.local 에 넣어둔 키를 키체인으로 옮기고 평문을 지운다.
  const migrated = await migrateEnvFile(app.isPackaged ? app.getPath('userData') : process.cwd());
  if (migrated.length > 0) {
    console.log(`[keychain] 키체인으로 이관: ${migrated.join(', ')} (.env.local 정리 완료)`);
  }

  const anthropicKey = await getKey(KEYS.anthropic);
  if (!anthropicKey) {
    console.warn(
      `[keychain] ${KEYS.anthropic} 없음. .env.local 에 넣고 재시작하세요. ` +
        '대화 기능만 막히고 나머지는 동작합니다.',
    );
  }

  // 1×1 투명 이미지 + setTitle 로 텍스트 아이콘. M3 에서 실제 아이콘으로 교체.
  tray = new Tray(nativeImage.createEmpty());
  refreshTray();

  state.on('change', (next: GoliathState) => {
    refreshTray();
    sendToRenderer(IPC.stateChanged, next);
  });
  state.on('releaseModels', () => engine.send({ type: 'models.release' }));
  state.on('listenWindowExpired', () => sendToRenderer(IPC.playSound, 'idle-return'));
  state.on('memoryExpired', () => console.log('[state] 대화 기억 만료 — 다음 발화는 새 대화'));

  engine.on('event', onEngineEvent);
  engine.on('fault', (message: string) => console.error(`[engine:fault] ${message}`));
  engine.start();

  // 전역 단축키: 웨이크워드 없이 바로 듣기 시작 / 비활성 토글 (2.4절).
  globalShortcut.register('Control+Command+G', () => {
    if (state.state === 'inactive') return;
    engine.send({ type: 'listen.start' });
    state.openListenWindow();
  });
  globalShortcut.register('Control+Command+Shift+G', () => toggleActive());

  ipcMain.on(IPC.command, (_event, payload: { type: string }) => {
    if (payload.type === 'toggle-active') toggleActive();
    if (payload.type === 'open-window') openWindow();
  });
  ipcMain.handle('goliath:get-state', () => state.state);
}

function shutdown(): void {
  void engine.stop().finally(() => {
    state.dispose();
    app.exit(0);
  });
}

app.whenReady().then(() => {
  // 4.3절: 시작 시 창을 띄우지 않고 메뉴바에만 나타난다.
  if (process.platform === 'darwin') app.dock?.hide();
  void bootstrap();
});

// 메뉴바 앱이므로 창을 닫아도 종료하지 않는다.
app.on('window-all-closed', () => {});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', (event) => {
  if (engine.isReady) {
    event.preventDefault();
    shutdown();
  }
});
