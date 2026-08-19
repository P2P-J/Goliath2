import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage } from 'electron';
import { resolve } from 'node:path';

import { IPC, type EngineEvent, type GoliathState } from '@shared/protocol';
import { VoiceEngine } from './engine';
import { ConversationState } from './state';
import type { Brain, BrainEvents } from './brain';
import { ClaudeSubscriptionBrain } from './brain-claude-subscription';
import { ClaudeApiBrain } from './brain-claude-api';
import { filterForSpeech } from './speech-filter';
import { KEYS, migrateEnvFile } from './keychain';

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
/**
 * 뇌 선택 (기획서 4절 원칙 3의 확장).
 *
 * 기본값은 구독이다 — 이미 내고 있는 것으로 되므로 추가 비용이 없다.
 * GOLIATH_BRAIN=api 로 API 키 경로를 쓸 수 있다 (별도 과금, 더 빠름).
 */
const brain: Brain =
  process.env.GOLIATH_BRAIN === 'api' ? new ClaudeApiBrain() : new ClaudeSubscriptionBrain();

/** 이번 턴에 엔진으로 보낸 발화 수. speak 의 id 를 만드는 데 쓴다. */
let turnSeq = 0;

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

/**
 * 창을 연다.
 *
 * @param steal 포커스를 가져올지. 웨이크워드로 깨어날 때는 false —
 *   기획서 7.2절: 창은 열리되 타이핑하던 곳에서 커서를 빼앗지 않는다.
 */
function openWindow(steal = true): void {
  if (window) {
    if (steal) {
      window.show();
      window.focus();
    } else {
      window.showInactive();
    }
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

  window.on('ready-to-show', () => (steal ? window?.show() : window?.showInactive()));
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

    case 'wake': {
      // 7.1절 기동 경험. 대기에서 깨어난 것이면 세션 시작 —
      // 부팅음과 함께 창이 열린다. 이미 대화 중이면 그냥 이어간다.
      const startingSession = !state.hasMemory;
      openWindow(false); // 포커스는 훔치지 않는다 (7.2절)
      // 소리는 세션을 시작할 때만 낸다. 매 턴 효과음이 울리면 시끄럽다.
      if (startingSession) sendToRenderer(IPC.playSound, 'boot');
      // TODO(M4): 세션 시작이면 음악 재생도 여기서 시작한다.
      engine.send({ type: 'listen.start' });
      state.openListenWindow();
      break;
    }

    case 'speech':
      // 말하는 중에 발화가 감지되면 끼어들기 (5.3절).
      if (event.active && state.state === 'speaking') {
        engine.send({ type: 'speak.cancel', id: 'current' });
        brain.abort(); // 남은 응답을 계속 생성할 이유가 없다
      }
      break;

    case 'transcript':
      if (event.discarded) {
        // 8.5절 환각 방지에 걸린 것. 조용히 대기로 돌아간다.
        if (state.state !== 'speaking') state.transition('idle');
        break;
      }
      void handleUserTurn(event.text);
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

/**
 * 사용자 발화 한 턴을 처리한다.
 *
 * 인식 → Claude → 필터 → 음성. 스트리밍이라 문장이 완성되는 대로 말하기
 * 시작한다. 응답을 다 기다렸다가 말하면 몇 초를 침묵한다.
 */
async function handleUserTurn(text: string): Promise<void> {
  state.transition('working');
  sendToRenderer(IPC.turnUpdated, { role: 'user', text, done: true });

  const turn = (turnSeq += 1);
  let spoken = 0;


  const events: BrainEvents = {
    onSentence: (sentence) => {
      // 8.2절 이중 방어: 프롬프트가 규칙을 어겨도 여기서 걸러진다.
      const { speech } = filterForSpeech(sentence);
      if (!speech) return;
      engine.send({
        type: 'speak',
        id: `t${turn}s${spoken}`,
        text: speech,
        queue: spoken > 0, // 첫 문장만 앞을 밀어내고, 이후는 이어 말한다
      });
      spoken += 1;
    },
    onText: (fullText) => {
      sendToRenderer(IPC.turnUpdated, { role: 'assistant', text: fullText, done: false });
    },
    onToolUse: (name) => {
      sendToRenderer(IPC.turnUpdated, { role: 'tool', text: name, done: true });
    },
    onError: (message) => {
      console.error(`[brain] ${message}`);
      sendToRenderer(IPC.playSound, 'error');
      sendToRenderer(IPC.turnUpdated, { role: 'error', text: message, done: true });
      engine.send({ type: 'speak', id: `t${turn}err`, text: message });
    },
  };

  await brain.ask(text, events);

  sendToRenderer(IPC.turnUpdated, { role: 'assistant', text: '', done: true });

  // 말할 것이 없었으면 (필터가 전부 걷어냈거나 빈 응답) 대화를 닫는다.
  if (spoken === 0 && state.state === 'working') state.openListenWindow();
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

  if (await brain.connect()) {
    console.log(`[brain] ${brain.name} 준비됨`);
  } else {
    console.warn(
      `[brain] ${brain.name} 를 쓸 수 없습니다. ` +
        (brain.name === 'claude-api'
          ? `${KEYS.anthropic} 를 .env.local 에 넣고 재시작하세요.`
          : 'Claude Code 로그인이 필요합니다 (claude 명령으로 확인).') +
        ' 대화만 막히고 귀·입·메뉴바는 동작합니다.',
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
  state.on('listenWindowExpired', () => {
    // 상태 기계는 메인이 소유한다. 창이 닫혔으면 엔진의 발화 수집도 멈춰야
    // 한다 — 알리지 않으면 엔진이 자체 타임아웃까지 혼자 기다린다.
    engine.send({ type: 'listen.stop' });
    sendToRenderer(IPC.playSound, 'idle-return');
  });
  state.on('memoryExpired', () => {
    // 8.2절: 기억이 만료되면 새 대화로 시작한다.
    brain.reset();
    console.log('[state] 대화 기억 만료 — 다음 발화는 새 대화');
  });

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
  void Promise.all([engine.stop(), brain.dispose()]).finally(() => {
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
