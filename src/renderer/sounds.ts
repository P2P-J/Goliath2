import type { SoundEvent } from '@shared/protocol';

/**
 * 사운드 디자인 (기획서 6절).
 *
 * Web Audio API 로 직접 합성한다 — 저작권 문제가 없고 톤과 길이를 자유롭게
 * 조정할 수 있다. 전부 페이드 인/아웃으로 클릭 노이즈를 제거한다.
 *
 * 6절 표의 수치를 그대로 옮겼다. 청취 후 조정 대상이다 (13절 미결).
 */

type Tone = {
  wave: OscillatorType;
  /** 주파수 궤적. 하나면 고정음, 여럿이면 순차 재생. */
  freqs: number[];
  /** 전체 길이(초). freqs 개수로 균등 분할한다. */
  duration: number;
  gain: number;
};

const RECIPES: Record<SoundEvent, Tone[]> = {
  // 부팅: 상승 3음 아르페지오 + 저역 스웰
  boot: [
    { wave: 'sine', freqs: [220, 440, 880], duration: 0.9, gain: 0.22 },
    { wave: 'sine', freqs: [110], duration: 0.9, gain: 0.1 },
  ],
  // 깨어남: 짧은 상승 2음
  wake: [{ wave: 'triangle', freqs: [660, 880], duration: 0.15, gain: 0.2 }],
  // 처리 중: 낮은 맥동 (루프는 startLoop 로 따로 처리)
  processing: [{ wave: 'sine', freqs: [110], duration: 0.5, gain: 0.14 }],
  // 완료: 하강 2음
  complete: [{ wave: 'sine', freqs: [880, 660], duration: 0.2, gain: 0.2 }],
  // 오류: 낮은 부저
  error: [{ wave: 'square', freqs: [160], duration: 0.25, gain: 0.14 }],
  // 대기 복귀: 아주 짧은 하강음
  'idle-return': [{ wave: 'sine', freqs: [660, 520], duration: 0.12, gain: 0.15 }],
  // 장치 전환: 짧은 클릭 2회
  'device-switch': [{ wave: 'square', freqs: [1200, 1200], duration: 0.06, gain: 0.08 }],
};

const FADE = 0.012; // 클릭 노이즈 제거용 페이드 (초)

export class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** 6절: 설정에서 개별 on/off 와 전체 볼륨 조절. */
  private muted = new Set<SoundEvent>();
  private volume = 1.0;

  /**
   * AudioContext 는 사용자 제스처 뒤에야 시작할 수 있다.
   * 첫 재생 시점에 만들고, suspended 면 되살린다.
   */
  private ensureContext(): { ctx: AudioContext; master: GainNode } {
    if (!this.ctx || !this.master) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return { ctx: this.ctx, master: this.master };
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master) this.master.gain.value = this.volume;
  }

  setMuted(sound: SoundEvent, muted: boolean): void {
    if (muted) this.muted.add(sound);
    else this.muted.delete(sound);
  }

  play(sound: SoundEvent): void {
    if (this.muted.has(sound)) return;
    const recipe = RECIPES[sound];
    if (!recipe) return;

    const { ctx, master } = this.ensureContext();
    const start = ctx.currentTime + 0.01;

    for (const tone of recipe) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = tone.wave;
      osc.connect(gain);
      gain.connect(master);

      // 주파수 궤적: setValueAtTime 으로 계단식 전이.
      const step = tone.duration / tone.freqs.length;
      tone.freqs.forEach((freq, i) => {
        osc.frequency.setValueAtTime(freq, start + step * i);
      });

      // 페이드 인/아웃
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(tone.gain, start + FADE);
      gain.gain.setValueAtTime(tone.gain, start + tone.duration - FADE);
      gain.gain.linearRampToValueAtTime(0, start + tone.duration);

      osc.start(start);
      osc.stop(start + tone.duration + 0.01);
    }
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}
