import { contextBridge, ipcRenderer } from 'electron';

import { IPC, type GoliathState, type SoundEvent } from '@shared/protocol';

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

  /** 3.4절 덕킹 복귀 판단: 사용자가 직접 멈춘 음악은 되살리지 않는다. */
  reportMusicState(playing: boolean, userStopped: boolean): void {
    ipcRenderer.send(IPC.musicState, { playing, userStopped });
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
