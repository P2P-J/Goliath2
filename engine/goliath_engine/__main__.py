"""골리앗 음성 엔진 — 골격.

지금은 어떤 모델도 로드하지 않는다. 프로토콜 왕복만 성립시켜서
메인 프로세스와의 경계를 먼저 굳히는 것이 목적이다.

붙일 순서 (기획서 M0 → M1):
  1. openWakeWord  → wake 이벤트
  2. VAD           → speech 이벤트
  3. Whisper       → transcript 이벤트 (5.3절 환각 방지 4중 대책 포함)
  4. Fish Audio    → speak.begin / speak.end (클라우드 API)

각 단계는 이 파일의 핸들러 안을 채우는 일이며,
protocol.py 와 protocol.ts 는 건드리지 않는다.
"""

from __future__ import annotations

import time
from typing import Any

from .protocol import Channel


class Engine:
    def __init__(self, channel: Channel) -> None:
        self.ch = channel
        self.config: dict[str, Any] = {}
        self.wake_enabled = False
        self.running = True
        # 현재 진행 중인 speak 의 id. 끼어들기 취소 대상을 식별한다.
        self.speaking_id: str | None = None

    # -- 명령 처리 ---------------------------------------------------------

    def handle(self, cmd: dict[str, Any]) -> None:
        kind = cmd.get("type")
        handler = getattr(self, f"_on_{kind.replace('.', '_')}", None) if kind else None
        if handler is None:
            self.ch.error("unknown_command", f"알 수 없는 명령: {kind!r}", fatal=False)
            return
        handler(cmd)

    def _on_wake_enable(self, _cmd: dict[str, Any]) -> None:
        # TODO(M1): openWakeWord 로드 + 마이크 스트림 열기.
        self.wake_enabled = True
        self.ch.log("웨이크워드 대기 시작 (스텁 — 마이크를 열지 않음)")

    def _on_wake_disable(self, _cmd: dict[str, Any]) -> None:
        # TODO(M2): 마이크 스트림을 실제로 닫아야 한다.
        #   기획서 2.4절: 메뉴바의 마이크 사용 표시(주황 점)가 사라져야 한다.
        self.wake_enabled = False
        self.ch.log("웨이크워드 대기 중지 (스텁)")

    def _on_listen_start(self, _cmd: dict[str, Any]) -> None:
        # TODO(M1): 발화 수집. VAD 로 침묵 1.2초를 감지하면 인식으로 넘어간다.
        self.ch.speech(active=True)
        self.ch.log("발화 수집 시작 (스텁)")

    def _on_listen_stop(self, _cmd: dict[str, Any]) -> None:
        self.ch.speech(active=False)
        # 골격 확인용 가짜 인식 결과. M1 에서 Whisper 로 대체된다.
        self.ch.transcript(
            text="(스텁) 아직 음성 인식이 붙지 않았습니다",
            confidence=0.0,
            latency_ms=0,
        )

    def _on_speak(self, cmd: dict[str, Any]) -> None:
        speak_id = cmd["id"]
        text = cmd["text"]
        self.speaking_id = speak_id
        # TODO(M1): Fish Audio 클라우드 API 호출 + 문장 단위 스트리밍 재생.
        #   실패 시 맥 내장 음성으로 폴백 (5.1절).
        #   원칙 1: 오디오는 이 프로세스 안에서만 흐른다. 경계를 넘지 않는다.
        self.ch.log(f"말하기 (스텁): {text[:60]!r}")
        self.ch.speak_begin(speak_id, first_audio_latency_ms=0)
        self.ch.speak_end(speak_id, cancelled=False)
        self.speaking_id = None

    def _on_speak_cancel(self, cmd: dict[str, Any]) -> None:
        speak_id = cmd.get("id")
        if self.speaking_id is not None and speak_id == self.speaking_id:
            # TODO(M2): 실제 재생 중단. 끼어들기 응답성이 여기 달려 있다.
            self.ch.speak_end(self.speaking_id, cancelled=True)
            self.speaking_id = None

    def _on_models_release(self, _cmd: dict[str, Any]) -> None:
        # TODO(M2): Whisper / TTS 를 메모리에서 실제로 내린다 (7.1절).
        self.ch.model("stt", loaded=False)
        self.ch.model("tts", loaded=False)

    def _on_config_set(self, cmd: dict[str, Any]) -> None:
        self.config.update(cmd.get("config") or {})
        self.ch.log(f"설정 갱신: {sorted((cmd.get('config') or {}).keys())}")

    def _on_metrics_request(self, _cmd: dict[str, Any]) -> None:
        # TODO(M6): psutil 로 실측. 7.2절 설정 화면의 실시간 표시에 쓰인다.
        self.ch.metrics(rss_mb=0.0, wake_cpu_percent=0.0, last_latency_ms=None)

    def _on_shutdown(self, _cmd: dict[str, Any]) -> None:
        self.running = False

    # -- 루프 -------------------------------------------------------------

    def run(self) -> None:
        self.ch.ready()
        for cmd in self.ch.commands():
            try:
                self.handle(cmd)
            except Exception as exc:  # 한 명령의 실패로 엔진을 죽이지 않는다.
                self.ch.error("handler_failed", f"{cmd.get('type')}: {exc}", fatal=False)
            if not self.running:
                break
        self.ch.log("종료")


def main() -> None:
    channel = Channel()
    try:
        Engine(channel).run()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        channel.error("engine_crashed", str(exc), fatal=True)
        raise


if __name__ == "__main__":
    main()
