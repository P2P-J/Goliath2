import { DUCK_LEVELS, MUSIC, type GoliathState, type MusicState, type Track } from '@shared/protocol';

/**
 * 음악 재생기 (기획서 9절).
 *
 * 원칙 2: 음악은 렌더러가 재생한다. 덕킹이 UI 상태와 같은 시계를 봐야 하기
 * 때문이다 — 메인에서 재생하면 상태가 바뀌는 순간과 볼륨이 줄어드는 순간이
 * 어긋난다.
 *
 * 덕킹은 두 볼륨의 곱이다.
 *   사용자 볼륨  설정에서 정한 것. 사용자만 바꾼다.
 *   덕킹 배수    상태에 따라 앱이 정한다. 대화 중 20%, 작업 중 60%.
 * 곱으로 두면 대화 중에 사용자가 볼륨을 올려도 덕킹이 유지된다.
 */
export class MusicPlayer {
  private audio = new Audio();
  private tracks: Track[] = [];
  private index = 0;
  private userVolume = 0.7;
  private duck = 1.0;
  private fadeTimer: number | null = null;
  private stoppedByUser = false;

  constructor(private readonly onChange: (state: MusicState) => void) {
    this.audio.preload = 'auto';
    this.audio.addEventListener('ended', () => this.next());
    this.audio.addEventListener('timeupdate', () => this.report());
    this.audio.addEventListener('loadedmetadata', () => this.report());
    this.audio.addEventListener('error', () => {
      // 파일이 사라졌거나 코덱을 못 읽는다. 멈추지 말고 다음 곡으로.
      if (this.tracks.length > 1) this.next();
    });
  }

  setLibrary(tracks: Track[], startIndex: number, volume: number): void {
    this.tracks = tracks;
    this.index = Math.min(startIndex, Math.max(0, tracks.length - 1));
    this.userVolume = volume;
    this.applyVolume();
    this.report();
  }

  // -- 재생 제어 ---------------------------------------------------------

  play(index?: number): void {
    if (this.tracks.length === 0) return;
    if (index !== undefined && index !== this.index) {
      this.index = Math.max(0, Math.min(index, this.tracks.length - 1));
      this.audio.src = '';
    }
    const track = this.tracks[this.index];
    if (!track) return;

    this.stoppedByUser = false;
    if (!this.audio.src || !this.audio.src.startsWith(MUSIC.scheme)) {
      this.audio.src = track.url;
    }
    void this.audio.play().catch(() => {
      /* 사용자 제스처 전이면 실패한다. 다음 시도에 붙는다. */
    });
    this.report();
  }

  pause(byUser = true): void {
    this.audio.pause();
    if (byUser) this.stoppedByUser = true;
    this.report();
  }

  toggle(): void {
    if (this.audio.paused) this.play();
    else this.pause();
  }

  stop(): void {
    this.audio.pause();
    this.audio.currentTime = 0;
    this.stoppedByUser = true;
    this.report();
  }

  next(): void {
    if (this.tracks.length === 0) return;
    this.index = (this.index + 1) % this.tracks.length;
    this.audio.src = this.tracks[this.index]!.url;
    if (!this.stoppedByUser) void this.audio.play().catch(() => {});
    this.report();
  }

  previous(): void {
    if (this.tracks.length === 0) return;
    // 3초 넘게 재생했으면 처음으로 되감는다 — 일반적인 플레이어 동작이다.
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      this.report();
      return;
    }
    this.index = (this.index - 1 + this.tracks.length) % this.tracks.length;
    this.audio.src = this.tracks[this.index]!.url;
    if (!this.stoppedByUser) void this.audio.play().catch(() => {});
    this.report();
  }

  seek(seconds: number): void {
    if (Number.isFinite(this.audio.duration)) {
      this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration));
      this.report();
    }
  }

  setVolume(value: number): void {
    this.userVolume = Math.max(0, Math.min(1, value));
    this.applyVolume();
    this.report();
  }

  // -- 덕킹 -------------------------------------------------------------

  /**
   * 상태에 맞춰 음악 볼륨을 줄이고 되돌린다 (9절 표).
   *
   * 줄일 때는 빠르게(0.3초), 되돌릴 때는 느긋하게(0.5초). 대화가 끝나자마자
   * 음악이 확 커지면 놀란다.
   */
  applyDuck(state: GoliathState): void {
    const target = DUCK_LEVELS[state] ?? 1.0;
    if (Math.abs(target - this.duck) < 0.01) return;
    const ms = target < this.duck ? MUSIC.duckFadeMs : MUSIC.restoreFadeMs;
    this.fadeTo(target, ms);
  }

  private fadeTo(target: number, ms: number): void {
    if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer);
    const from = this.duck;
    const started = performance.now();
    this.fadeTimer = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - started) / ms);
      this.duck = from + (target - from) * t;
      this.applyVolume();
      if (t >= 1 && this.fadeTimer !== null) {
        window.clearInterval(this.fadeTimer);
        this.fadeTimer = null;
      }
    }, 16);
  }

  private applyVolume(): void {
    this.audio.volume = Math.max(0, Math.min(1, this.userVolume * this.duck));
  }

  // -- 상태 보고 ---------------------------------------------------------

  private report(): void {
    const track = this.tracks[this.index];
    this.onChange({
      playing: !this.audio.paused && !this.audio.ended,
      index: this.index,
      title: track?.title ?? null,
      position: this.audio.currentTime || 0,
      duration: Number.isFinite(this.audio.duration) ? this.audio.duration : 0,
      volume: this.userVolume,
      stoppedByUser: this.stoppedByUser,
    });
  }

  get hasTracks(): boolean {
    return this.tracks.length > 0;
  }

  /** 9절: 사용자가 직접 멈춘 음악은 대화가 끝나도 자동 재생되지 않는다. */
  get wasStoppedByUser(): boolean {
    return this.stoppedByUser;
  }

  dispose(): void {
    if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer);
    this.audio.pause();
    this.audio.src = '';
  }
}
