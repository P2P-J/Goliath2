import { app } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_VOICE_CONFIG, type VoiceSettings } from '@shared/protocol';

/**
 * 목소리 설정 보관 (기획서 3장 "속도·톤 커스텀").
 *
 * 엔진은 처음부터 config.set 을 받을 준비가 되어 있었고, 없던 것은 그 값을
 * 기억하고 보내주는 쪽뿐이다. 그래서 여기는 파일 하나만 다룬다.
 *
 * 음악 설정과 파일을 나눈 이유: 지우고 초기화하는 단위가 다르다.
 * 음악 폴더를 바꾸는 것과 목소리를 되돌리는 것은 서로 무관하다.
 */
export class VoiceStore {
  private current: VoiceSettings = {
    voice: DEFAULT_VOICE_CONFIG.voice,
    preset: DEFAULT_VOICE_CONFIG.preset,
    speed: DEFAULT_VOICE_CONFIG.speed,
    pitchFactor: DEFAULT_VOICE_CONFIG.pitchFactor,
  };

  private get path(): string {
    return join(app.getPath('userData'), 'voice.json');
  }

  get value(): VoiceSettings {
    return this.current;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf-8');
      this.current = { ...this.current, ...(JSON.parse(raw) as Partial<VoiceSettings>) };
    } catch {
      // 첫 실행. 청취해서 정한 기본값으로 간다.
    }
  }

  /** 들어온 값을 범위 안으로 접어 넣고 저장한다. 바뀐 최종값을 돌려준다. */
  async update(next: Partial<VoiceSettings>): Promise<VoiceSettings> {
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    this.current = {
      voice: next.voice ?? this.current.voice,
      preset: next.preset ?? this.current.preset,
      // 범위는 protocol.ts 의 EngineConfig 주석과 같다.
      speed: clamp(next.speed ?? this.current.speed, 0.7, 2.0),
      pitchFactor: clamp(next.pitchFactor ?? this.current.pitchFactor, 1.0, 1.3),
    };
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.current, null, 2), 'utf-8');
    return this.current;
  }
}
