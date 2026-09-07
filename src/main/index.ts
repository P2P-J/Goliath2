import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage } from 'electron';
import { resolve } from 'node:path';

import {
  IPC,
  type EngineEvent,
  type GoliathState,
  type MusicControl,
  type MusicState,
  type VoiceSettings,
} from '@shared/protocol';
import { VoiceEngine } from './engine';
import { ConversationState } from './state';
import type { Brain, BrainEvents } from './brain';
import { ClaudeSubscriptionBrain } from './brain-claude-subscription';
import { ClaudeApiBrain } from './brain-claude-api';
import { filterForSpeech } from './speech-filter';
import { KEYS, migrateEnvFile } from './keychain';
import { MusicLibrary } from './music';
import { VoiceStore } from './settings';
import { acknowledge, matchMusicCommand } from './voice-commands';

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

const music = new MusicLibrary();
const voice = new VoiceStore();
/** 렌더러가 알려주는 재생 상태. 자동 재생 여부 판단에 쓴다 (9절). */
let musicState: MusicState | null = null;

/** 이번 턴에 엔진으로 보낸 발화 수. speak 의 id 를 만드는 데 쓴다. */
let turnSeq = 0;

/**
 * 엔진에 보냈고 아직 끝나지 않은 발화의 id.
 *
 * 답을 문장 단위로 흘려보내므로 한 턴에 speak 가 여러 번 나가고, speak.end
 * 도 문장마다 온다. 그때마다 청취 창을 열면 답하는 도중에 화면이
 * "듣고 있습니다"로 깜빡이고 사용자는 말해도 되는 줄 안다. 마지막 문장이
 * 끝나야 답이 끝난 것이다.
 */
const pendingSpeech = new Set<string>();

/** 미리듣기 발화의 id 앞머리. 대화 상태를 건드리지 않고 지나간다. */
const PREVIEW_ID = 'preview:';

/** 발화를 보내면서 미결 목록에 올린다. speak 는 반드시 이 함수를 거친다. */
function speak(id: string, text: string, queue = false): void {
  pendingSpeech.add(id);
  engine.send({ type: 'speak', id, text, queue });
}

/**
 * 진행 중인 턴. 한 번에 하나만 돌린다.
 *
 * 뇌가 생각하는 동안에도 귀는 열려 있어서 두 번째 발화가 들어올 수 있다.
 * 그대로 두면 brain.ask 가 겹쳐 호출되는데, 앞 턴의 result 가 뒤 턴을
 * 대신 끝내 버려 두 번째 질문의 답이 통째로 사라진다.
 */
let turnChain: Promise<void> = Promise.resolve();

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
      // 엔진이 되살아났다. 죽은 발화의 id 가 남아 있으면 청취 창이 영영
      // 열리지 않는다.
      pendingSpeech.clear();
      // 엔진은 기본값으로 뜬다. 저장된 목소리가 있으면 여기서 덮어쓴다 —
      // 재기동한 경우에도 사용자가 고른 목소리로 돌아온다.
      engine.send({ type: 'config.set', config: voice.value });
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
      if (startingSession) {
        sendToRenderer(IPC.playSound, 'boot');
        // 7.1절 기동 경험: 부팅음과 함께 음악이 시작된다.
        // 단, 사용자가 직접 멈춘 음악은 되살리지 않는다 (9절).
        if (!musicState?.stoppedByUser) {
          sendToRenderer(IPC.musicControl, { type: 'play' } satisfies MusicControl);
        }
      }
      engine.send({ type: 'listen.start' });
      state.openListenWindow();
      break;
    }

    case 'speech':
      if (event.active) {
        // 말하는 중에 발화가 감지되면 끼어들기 (5.3절).
        if (state.state === 'speaking') {
          engine.send({ type: 'speak.cancel', id: 'current' });
          brain.abort(); // 남은 응답을 계속 생성할 이유가 없다
        }
      } else if (state.state === 'listening') {
        // 발화가 끝났다. 인식에 1~3초가 걸리므로 그동안 "듣고 있습니다"를
        // 계속 띄우면 말을 못 알아들은 것처럼 보인다.
        state.transition('transcribing');
      }
      break;

    case 'transcript': {
      if (event.discarded) {
        // 8.5절 환각 방지에 걸린 것. 기침 한 번, 키보드 소리 한 번에도
        // 걸리므로 대기로 내리면 안 된다 — 엔진의 청취 창은 그대로 열려
        // 있는데 화면만 "대기 중"이 되어 상태가 어긋난다.
        if (state.state === 'transcribing' || state.state === 'listening') {
          state.openListenWindow();
        }
        break;
      }
      // 음악 조작은 뇌를 거치지 않는다. 왕복 3초를 기다릴 이유가 없다 (9절).
      const command = matchMusicCommand(event.text);
      if (command) {
        handleMusicCommand(command, event.text);
        break;
      }
      // 앞 턴이 끝난 뒤에 시작한다. 겹쳐 돌리면 답이 뒤섞인다.
      turnChain = turnChain.then(() => handleUserTurn(event.text));
      break;
    }

    case 'speak.begin':
      if (event.id.startsWith(PREVIEW_ID)) break;
      state.transition('speaking');
      break;

    case 'speak.end':
      if (event.id.startsWith(PREVIEW_ID)) break;
      pendingSpeech.delete(event.id);
      // 남은 문장이 없을 때만 청취 창을 연다. 'speaking' 이 아니면 이미
      // 다음 턴이 시작된 것이므로 건드리지 않는다.
      if (pendingSpeech.size === 0 && state.state === 'speaking') {
        state.openListenWindow();
      }
      break;

    case 'device':
      // 장치 변경은 화면으로만 알린다.
      sendToRenderer(IPC.turnUpdated, {
        role: 'tool',
        text: `출력 장치: ${event.output}`,
        done: true,
      });
      break;

    case 'error':
      console.error(`[engine:${event.code}] ${event.message}`);
      sendToRenderer(IPC.turnUpdated, { role: 'error', text: event.message, done: true });
      break;

    case 'model':
    case 'metrics':
      sendToRenderer(IPC.turnUpdated, event);
      break;
  }
}

/**
 * 음성으로 온 음악 조작을 처리한다.
 *
 * 뇌를 거치지 않으므로 즉시 반응한다. 대신 무엇을 했는지 짧게 말해 준다 —
 * 아무 반응이 없으면 못 알아들은 것과 구분되지 않는다.
 */
function handleMusicCommand(command: MusicControl, heard: string): void {
  sendToRenderer(IPC.turnUpdated, { role: 'user', text: heard, done: true });
  sendToRenderer(IPC.musicControl, command);

  const reply = acknowledge(command);
  if (reply) {
    sendToRenderer(IPC.turnUpdated, { role: 'assistant', text: reply, done: true });
    speak(`m${(turnSeq += 1)}`, reply);
  } else {
    state.openListenWindow();
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
      // 첫 문장만 앞을 밀어내고, 이후는 이어 말한다.
      speak(`t${turn}s${spoken}`, speech, spoken > 0);
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
      sendToRenderer(IPC.turnUpdated, { role: 'error', text: message, done: true });
      speak(`t${turn}err`, message);
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

  await voice.load();

  music.registerHandler();
  await music.load();
  if (music.folder) {
    console.log(`[music] ${music.list.length}곡 · ${music.folder}`);
  }

  // 1×1 투명 이미지 + setTitle 로 텍스트 아이콘. M6 에서 실제 아이콘으로 교체.
  tray = new Tray(nativeImage.createEmpty());
  refreshTray();

  state.on('change', (next: GoliathState) => {
    refreshTray();
    // 덕킹은 렌더러가 건다 (원칙 2). 상태만 넘기면 된다.
    sendToRenderer(IPC.stateChanged, next);
  });
  state.on('releaseModels', () => engine.send({ type: 'models.release' }));
  state.on('listenWindowExpired', () => {
    // 상태 기계는 메인이 소유한다. 창이 닫혔으면 청취 창도 닫아야 한다.
    // 소리는 내지 않는다 — 듣는 중인지 아닌지는 화면으로만 보여준다.
    engine.send({ type: 'listen.stop' });
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
  ipcMain.on(IPC.musicState, (_event, next: MusicState) => {
    musicState = next;
    void music.setVolume(next.volume);
    void music.setStartIndex(next.index);
  });
  ipcMain.on(IPC.musicControl, (_event, control: MusicControl) => {
    sendToRenderer(IPC.musicControl, control);
  });
  ipcMain.handle('goliath:get-state', () => state.state);
  ipcMain.handle('goliath:get-voice', () => voice.value);
  ipcMain.handle('goliath:set-voice', async (_event, next: Partial<VoiceSettings>) => {
    const applied = await voice.update(next);
    engine.send({ type: 'config.set', config: applied });
    return applied;
  });
  ipcMain.on('goliath:preview-voice', () => {
    // 고른 목소리를 바로 들려준다. 글로만 고르면 열 종을 구분할 수 없다.
    // speak() 를 거치지 않는다 — 미리듣기는 대화가 아니므로 상태도 청취 창도
    // 건드리면 안 된다. 목소리를 훑어보다 말고 대화가 시작되면 곤란하다.
    engine.send({
      type: 'speak',
      id: `${PREVIEW_ID}${(turnSeq += 1)}`,
      text: '골리앗 온라인. 명령을 기다립니다.',
    });
  });
  ipcMain.handle('goliath:music-library', () => ({
    tracks: music.list,
    folder: music.folder,
    startIndex: music.startIndex,
    volume: music.volume,
  }));
  ipcMain.handle('goliath:choose-music-folder', async () => {
    const ok = await music.chooseFolder();
    if (ok) {
      sendToRenderer(IPC.musicLibrary, {
        tracks: music.list,
        folder: music.folder,
        startIndex: 0,
        volume: music.volume,
      });
    }
    return ok;
  });
}

function shutdown(): void {
  void Promise.all([engine.stop(), brain.dispose()]).finally(() => {
    state.dispose();
    app.exit(0);
  });
}

// 커스텀 스킴은 앱이 준비되기 전에 등록해야 한다.
MusicLibrary.registerScheme();

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
