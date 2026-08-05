import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface, type Interface } from 'node:readline';
import { resolve } from 'node:path';

import {
  PROTOCOL_VERSION,
  type EngineCommand,
  type EngineEvent,
} from '@shared/protocol';

/**
 * 음성 엔진(Python) 자식 프로세스 감독자.
 *
 * 책임은 셋뿐이다:
 *   1. 엔진을 띄우고 프로토콜 버전이 맞는지 확인한다.
 *   2. 줄 단위 JSON 을 EngineEvent 로 바꿔 내보낸다.
 *   3. 엔진이 죽으면 되살린다.
 *
 * 오디오는 여기를 지나가지 않는다 (기획서 10절 원칙 1).
 */
export class VoiceEngine extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private handshakeDone = false;
  private restarts = 0;
  private stopping = false;

  /** 연속 재기동 상한. 넘으면 포기하고 사용자에게 알린다. */
  private static readonly MAX_RESTARTS = 5;
  private static readonly RESTART_BACKOFF_MS = 1_000;

  constructor(
    private readonly pythonPath = process.env.GOLIATH_PYTHON ?? 'python3',
    private readonly engineDir = resolve(process.cwd(), 'engine'),
  ) {
    super();
  }

  start(): void {
    if (this.proc) return;
    this.stopping = false;
    this.handshakeDone = false;

    const proc = spawn(this.pythonPath, ['-u', '-m', 'goliath_engine'], {
      cwd: this.engineDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    this.proc = proc;

    this.reader = createInterface({ input: proc.stdout });
    this.reader.on('line', (line) => this.onLine(line));

    // stderr 는 로그 전용 — 파싱하지 않고 그대로 흘린다.
    proc.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    proc.on('exit', (code, signal) => this.onExit(code, signal));
    proc.on('error', (err) => {
      this.emit('fault', `엔진을 실행할 수 없습니다: ${err.message}`);
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: EngineEvent;
    try {
      event = JSON.parse(trimmed) as EngineEvent;
    } catch {
      // 엔진이 stdout 에 프로토콜 외 출력을 섞은 것. 버그이므로 눈에 보이게 둔다.
      this.emit('fault', `엔진 출력을 해석할 수 없습니다: ${trimmed.slice(0, 200)}`);
      return;
    }

    if (event.type === 'ready') {
      if (event.protocolVersion !== PROTOCOL_VERSION) {
        this.emit(
          'fault',
          `프로토콜 버전 불일치: 앱 ${PROTOCOL_VERSION} / 엔진 ${event.protocolVersion}. ` +
            'src/shared/protocol.ts 와 engine/goliath_engine/protocol.py 를 함께 맞추세요.',
        );
        void this.stop();
        return;
      }
      this.handshakeDone = true;
      this.restarts = 0;
    }

    this.emit('event', event);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.reader?.close();
    this.reader = null;
    this.proc = null;

    if (this.stopping) return;

    // 정상 종료가 아니면 되살린다. 8.1절 세션 복구와는 별개 — 여기는 엔진만 본다.
    if (this.restarts >= VoiceEngine.MAX_RESTARTS) {
      this.emit(
        'fault',
        `엔진이 ${VoiceEngine.MAX_RESTARTS}회 연속 종료되어 재기동을 멈췄습니다 ` +
          `(code=${code} signal=${signal}).`,
      );
      return;
    }
    this.restarts += 1;
    setTimeout(() => this.start(), VoiceEngine.RESTART_BACKOFF_MS * this.restarts);
  }

  send(command: EngineCommand): void {
    if (!this.proc || !this.handshakeDone) {
      // 핸드셰이크 전 명령은 버린다. 상태 기계가 ready 를 기다리고 나서 보내야 한다.
      this.emit('fault', `엔진 준비 전 명령 무시: ${command.type}`);
      return;
    }
    this.proc.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const proc = this.proc;
    if (!proc) return;

    // 먼저 정중히 부탁하고, 안 죽으면 SIGTERM.
    try {
      proc.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    } catch {
      // stdin 이 이미 닫혔으면 넘어간다.
    }

    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        done();
      }, 2_000);
      proc.once('exit', () => {
        clearTimeout(timer);
        done();
      });
    });
  }

  get isReady(): boolean {
    return this.handshakeDone;
  }
}
