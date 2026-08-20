import { app, dialog, net, protocol } from 'electron';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MUSIC, type Track } from '@shared/protocol';

/**
 * 음악 라이브러리 (기획서 9절).
 *
 * 원칙 2: 음악은 렌더러가 재생한다. 여기는 목록을 만들고 설정을 기억할 뿐,
 * 소리를 다루지 않는다.
 *
 * 파일을 앱 안으로 복사하지 않는다. 사용자가 고른 폴더를 그대로 읽는다 —
 * 음악을 두 벌 갖고 있을 이유가 없다.
 */

interface Settings {
  folder: string | null;
  volume: number;
  /** 앱을 켤 때 이 곡부터 순차 재생 (9절 "시작 곡 지정"). */
  startIndex: number;
}

const DEFAULTS: Settings = { folder: null, volume: 0.7, startIndex: 0 };

/** 재생목록 상한. 9절이 50곡 이하를 전제하지만 실수로 큰 폴더를 골라도 버텨야 한다. */
const MAX_TRACKS = 500;

export class MusicLibrary {
  private settings: Settings = { ...DEFAULTS };
  private tracks: Track[] = [];

  private get settingsPath(): string {
    return join(app.getPath('userData'), 'music.json');
  }

  /**
   * 렌더러가 로컬 파일을 읽을 통로를 연다.
   *
   * file:// 는 렌더러에서 막혀 있다. webSecurity 를 끄는 대신 전용 스킴을
   * 열어 우리가 고른 폴더 안의 파일만 내준다 — 폴더 밖 경로는 거부한다.
   */
  static registerScheme(): void {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: MUSIC.scheme,
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
      },
    ]);
  }

  registerHandler(): void {
    protocol.handle(MUSIC.scheme, (request) => {
      const target = decodeURIComponent(new URL(request.url).pathname);
      const folder = this.settings.folder;
      // 폴더 밖은 내주지 않는다. 렌더러가 임의 경로를 요청해도 막힌다.
      if (!folder || !resolve(target).startsWith(resolve(folder) + sep)) {
        return new Response('not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(target).toString());
    });
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath, 'utf-8');
      this.settings = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
    } catch {
      // 첫 실행. 기본값으로 간다.
    }
    if (this.settings.folder) await this.scan();
  }

  private async save(): Promise<void> {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf-8');
  }

  /** 폴더를 골라 재생목록으로 삼는다. 취소하면 false. */
  async chooseFolder(): Promise<boolean> {
    const picked = await dialog.showOpenDialog({
      title: '음악 폴더 고르기',
      properties: ['openDirectory'],
      message: '이 폴더의 음악이 재생목록이 됩니다',
    });
    if (picked.canceled || !picked.filePaths[0]) return false;
    this.settings.folder = picked.filePaths[0];
    this.settings.startIndex = 0;
    await this.scan();
    await this.save();
    return true;
  }

  /** 폴더를 다시 훑는다. 하위 폴더는 한 겹까지만 본다. */
  async scan(): Promise<Track[]> {
    const folder = this.settings.folder;
    if (!folder) {
      this.tracks = [];
      return this.tracks;
    }

    const found: string[] = [];
    const isAudio = (name: string) =>
      (MUSIC.extensions as readonly string[]).includes(extname(name).toLowerCase());

    try {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(folder, entry.name);
        if (entry.isFile() && isAudio(entry.name)) {
          found.push(full);
        } else if (entry.isDirectory()) {
          try {
            for (const sub of await readdir(full, { withFileTypes: true })) {
              if (sub.isFile() && !sub.name.startsWith('.') && isAudio(sub.name)) {
                found.push(join(full, sub.name));
              }
            }
          } catch {
            // 읽을 수 없는 하위 폴더는 건너뛴다.
          }
        }
      }
    } catch (error) {
      console.error('[music] 폴더를 읽을 수 없습니다:', (error as Error).message);
      this.tracks = [];
      return this.tracks;
    }

    found.sort((a, b) => a.localeCompare(b, 'ko'));
    this.tracks = found.slice(0, MAX_TRACKS).map((path) => ({
      path,
      title: basename(path, extname(path)),
      url: `${MUSIC.scheme}://local${path.split(sep).map(encodeURIComponent).join('/')}`,
    }));
    return this.tracks;
  }

  get list(): Track[] {
    return this.tracks;
  }

  get folder(): string | null {
    return this.settings.folder;
  }

  get volume(): number {
    return this.settings.volume;
  }

  get startIndex(): number {
    return Math.min(this.settings.startIndex, Math.max(0, this.tracks.length - 1));
  }

  async setVolume(value: number): Promise<void> {
    this.settings.volume = Math.max(0, Math.min(1, value));
    await this.save();
  }

  async setStartIndex(index: number): Promise<void> {
    this.settings.startIndex = Math.max(0, index);
    await this.save();
  }
}
