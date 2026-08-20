import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC,
  type GoliathState,
  type MusicControl,
  type MusicState,
  type SoundEvent,
} from '@shared/protocol';

interface Library {
  tracks: { url: string; title: string; path: string }[];
  folder: string | null;
  startIndex: number;
  volume: number;
}

/**
 * 렌더러가 쓸 수 있는 것만 노출한다. nodeIntegration 은 꺼져 있다.
 *
 * 오디오는 이 경계를 넘지 않는다 (10절 원칙 1). 여기로 오는 것은
 * 상태 문자열, 대화 텍스트, 효과음 이름뿐이다.
 */
const api = {
  onStateChanged(listener: (state: GoliathState) => void): () => void {
    const handler = (_e: unknown, state: GoliathState) => listener(state);
    ipcRenderer.on(IPC.stateChanged, handler);
    return () => ipcRenderer.off(IPC.stateChanged, handler);
  },

  onTurnUpdated(listener: (turn: unknown) => void): () => void {
    const handler = (_e: unknown, turn: unknown) => listener(turn);
    ipcRenderer.on(IPC.turnUpdated, handler);
    return () => ipcRenderer.off(IPC.turnUpdated, handler);
  },

  /** 6절: 합성은 렌더러가 Web Audio API 로 한다. 메인은 이름만 보낸다. */
  onPlaySound(listener: (sound: SoundEvent) => void): () => void {
    const handler = (_e: unknown, sound: SoundEvent) => listener(sound);
    ipcRenderer.on(IPC.playSound, handler);
    return () => ipcRenderer.off(IPC.playSound, handler);
  },

  // -- 음악 (9절). 재생은 렌더러가 한다 — 원칙 2. -----------------------

  /** 9절 덕킹 복귀 판단: 사용자가 직접 멈춘 음악은 되살리지 않는다. */
  reportMusicState(state: MusicState): void {
    ipcRenderer.send(IPC.musicState, state);
  },

  /** 메인이 보내는 재생 명령 — 음성 명령과 기동 시퀀스가 여기로 온다. */
  onMusicControl(listener: (control: MusicControl) => void): () => void {
    const handler = (_e: unknown, control: MusicControl) => listener(control);
    ipcRenderer.on(IPC.musicControl, handler);
    return () => ipcRenderer.off(IPC.musicControl, handler);
  },

  onMusicLibrary(listener: (library: Library) => void): () => void {
    const handler = (_e: unknown, library: Library) => listener(library);
    ipcRenderer.on(IPC.musicLibrary, handler);
    return () => ipcRenderer.off(IPC.musicLibrary, handler);
  },

  getMusicLibrary(): Promise<Library> {
    return ipcRenderer.invoke('goliath:music-library');
  },

  chooseMusicFolder(): Promise<boolean> {
    return ipcRenderer.invoke('goliath:choose-music-folder');
  },

  /** 화면에서 조작한 것을 메인을 거쳐 되돌려 받는다 — 경로를 하나로 유지한다. */
  control(command: MusicControl): void {
    ipcRenderer.send(IPC.musicControl, command);
  },

  command(type: 'toggle-active' | 'open-window'): void {
    ipcRenderer.send(IPC.command, { type });
  },

  getState(): Promise<GoliathState> {
    return ipcRenderer.invoke('goliath:get-state');
  },
};

contextBridge.exposeInMainWorld('goliath', api);

export type GoliathApi = typeof api;
