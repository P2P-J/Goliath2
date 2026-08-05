import { execFile } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const run = promisify(execFile);

const SERVICE = 'goliath';

/**
 * 기획서 8.3절: API 키는 macOS 키체인에 저장한다. 설정 파일에 평문으로 두지 않는다.
 *
 * 네이티브 모듈(keytar) 대신 macOS 내장 `security` CLI 를 쓴다.
 *   - Electron 용 리빌드가 필요 없다.
 *   - 키 자체가 키체인에 들어가므로 키체인 접근.app 에서 확인·삭제할 수 있다.
 */

export async function getKey(account: string): Promise<string | null> {
  try {
    const { stdout } = await run('security', [
      'find-generic-password',
      '-s', SERVICE,
      '-a', account,
      '-w',
    ]);
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    // 항목이 없으면 exit 44. 없는 것과 오류를 구분할 필요가 없으므로 null.
    return null;
  }
}

export async function setKey(account: string, secret: string): Promise<void> {
  // -U 는 기존 항목을 덮어쓴다. -w 로 값을 넘기면 프로세스 인자에 노출되므로
  // stdin 을 쓰는 편이 낫지만, security 는 stdin 입력을 지원하지 않는다.
  // 개인용 단일 사용자 머신이라 감수한다 — 더 엄격히 하려면 safeStorage 로 바꾼다.
  await run('security', [
    'add-generic-password',
    '-s', SERVICE,
    '-a', account,
    '-w', secret,
    '-U',
  ]);
}

export async function deleteKey(account: string): Promise<void> {
  try {
    await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
  } catch {
    // 없으면 지울 것도 없다.
  }
}

/** 우리가 쓰는 키 목록. 여기에 없는 이름은 저장하지 않는다. */
export const KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  fishAudio: 'FISH_AUDIO_API_KEY',
  googleClientId: 'GOOGLE_CLIENT_ID',
  googleClientSecret: 'GOOGLE_CLIENT_SECRET',
} as const;

export type KeyName = (typeof KEYS)[keyof typeof KEYS];

/**
 * .env.local 에 적힌 키를 키체인으로 옮기고 파일을 지운다.
 *
 * 사용자는 편한 방식(파일 편집)으로 키를 넣고, 앱은 안전한 곳(키체인)에 보관한다.
 * 옮긴 뒤 파일을 지우므로 평문이 디스크에 남지 않는다.
 *
 * @returns 이관한 키 이름들
 */
export async function migrateEnvFile(
  projectRoot = process.cwd(),
): Promise<KeyName[]> {
  const envPath = resolve(projectRoot, '.env.local');

  let contents: string;
  try {
    contents = await readFile(envPath, 'utf-8');
  } catch {
    return []; // 파일이 없는 것은 정상이다.
  }

  const known = new Set<string>(Object.values(KEYS));
  const migrated: KeyName[] = [];
  const leftover: string[] = [];

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      leftover.push(rawLine);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 1) {
      leftover.push(rawLine);
      continue;
    }
    const name = line.slice(0, eq).trim();
    // 값이 따옴표로 감싸여 있으면 벗긴다.
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');

    if (!known.has(name) || value.length === 0) {
      leftover.push(rawLine); // 모르는 항목은 건드리지 않는다.
      continue;
    }

    await setKey(name, value);
    migrated.push(name as KeyName);
  }

  if (migrated.length === 0) return [];

  // 이관한 키가 하나라도 있으면 평문을 없앤다.
  const remaining = leftover.join('\n').trim();
  if (remaining.length > 0) {
    await writeFile(envPath, `${remaining}\n`, 'utf-8');
  } else {
    await unlink(envPath);
  }

  return migrated;
}
