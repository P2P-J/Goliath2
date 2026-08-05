"""골리앗 프로세스 경계 프로토콜 — Python 측.

src/shared/protocol.ts 의 거울이다. 한쪽만 고치면 안 된다.
PROTOCOL_VERSION 이 어긋나면 메인 프로세스가 시작 시 거부한다.

전송 방식: stdin/stdout 에 줄 단위 JSON (UTF-8).
stderr 는 로그 전용 — 메인은 파싱하지 않고 그대로 흘린다.
"""

from __future__ import annotations

import json
import sys
import threading
from typing import Any

PROTOCOL_VERSION = 1
ENGINE_VERSION = "0.1.0"


class Channel:
    """줄 단위 JSON 채널.

    stdout 은 프로토콜 전용이다. 엔진 코드 어디서도 print() 를 쓰면 안 된다 —
    한 줄이라도 섞이면 메인의 파서가 깨진다. 로그는 log() 로 stderr 에 쓴다.
    """

    def __init__(self) -> None:
        # 여러 스레드(웨이크워드 감지, VAD, TTS 재생)가 같은 stdout 에 쓴다.
        self._write_lock = threading.Lock()

    def send(self, event: dict[str, Any]) -> None:
        line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def commands(self):
        """stdin 에서 명령을 읽어 yield 한다. EOF 면 종료."""
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                yield json.loads(raw)
            except json.JSONDecodeError as exc:
                # 명령 한 줄이 깨졌다고 엔진이 죽을 이유는 없다.
                self.error("bad_command", f"JSON 파싱 실패: {exc}", fatal=False)

    # -- 이벤트 헬퍼. protocol.ts 의 EngineEvent 와 1:1 대응 -----------------

    def ready(self) -> None:
        self.send(
            {
                "type": "ready",
                "protocolVersion": PROTOCOL_VERSION,
                "engineVersion": ENGINE_VERSION,
            }
        )

    def wake(self, confidence: float) -> None:
        self.send({"type": "wake", "confidence": confidence})

    def speech(self, active: bool) -> None:
        self.send({"type": "speech", "active": active})

    def transcript(
        self,
        text: str,
        confidence: float,
        latency_ms: int,
        discarded: bool = False,
        reason: str | None = None,
    ) -> None:
        event: dict[str, Any] = {
            "type": "transcript",
            "text": text,
            "confidence": confidence,
            "discarded": discarded,
            "latencyMs": latency_ms,
        }
        if reason is not None:
            event["reason"] = reason
        self.send(event)

    def speak_begin(self, speak_id: str, first_audio_latency_ms: int) -> None:
        self.send(
            {
                "type": "speak.begin",
                "id": speak_id,
                "firstAudioLatencyMs": first_audio_latency_ms,
            }
        )

    def speak_end(self, speak_id: str, cancelled: bool) -> None:
        self.send({"type": "speak.end", "id": speak_id, "cancelled": cancelled})

    def model(self, which: str, loaded: bool, load_ms: int | None = None) -> None:
        event: dict[str, Any] = {"type": "model", "which": which, "loaded": loaded}
        if load_ms is not None:
            event["loadMs"] = load_ms
        self.send(event)

    def device(self, input_name: str, output_name: str, output_is_bluetooth: bool) -> None:
        self.send(
            {
                "type": "device",
                "input": input_name,
                "output": output_name,
                "outputIsBluetooth": output_is_bluetooth,
            }
        )

    def metrics(self, rss_mb: float, wake_cpu_percent: float, last_latency_ms: int | None) -> None:
        self.send(
            {
                "type": "metrics",
                "rssMb": rss_mb,
                "wakeCpuPercent": wake_cpu_percent,
                "lastLatencyMs": last_latency_ms,
            }
        )

    def error(self, code: str, message: str, fatal: bool) -> None:
        self.send({"type": "error", "code": code, "message": message, "fatal": fatal})

    def log(self, message: str) -> None:
        """stderr 로만 나간다. stdout 을 오염시키지 않는다."""
        sys.stderr.write(f"[engine] {message}\n")
        sys.stderr.flush()
