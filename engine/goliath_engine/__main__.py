"""골리앗 음성 엔진.

붙은 것 / 아직인 것
  입(TTS)      수퍼토닉 — 문장 단위 스트리밍 재생, 끼어들기 취소 ✅
  귀(STT)      Whisper — backends.py 에 자리만 있음
  웨이크워드    openWakeWord — 자리만 있음

프로토콜(protocol.py)과 뒷단(backends.py)은 이 파일이 바뀌어도 바뀌지 않는다.
"""

from __future__ import annotations

import threading
from typing import Any

from .audio_fx import FxConfig, VoicePreset
from .backends import SpeechRequest, default_tts
from .protocol import Channel

#: protocol.ts 의 DEFAULT_VOICE_CONFIG 와 짝을 이룬다.
#: M1 보이스 + 자비스 프리셋 — 10종을 직접 청취해 확정했다.
DEFAULT_CONFIG: dict[str, Any] = {
    "voice": "M1",
    "preset": "jarvis",
    "speed": 1.35,
    "pitchFactor": 1.07,
    "fxIntensity": 1.0,
    "steps": 8,
    "language": "ko",
}


class Engine:
    def __init__(self, channel: Channel) -> None:
        self.ch = channel
        self.config: dict[str, Any] = dict(DEFAULT_CONFIG)
        self.tts = default_tts()
        self.wake_enabled = False
        self.running = True

        #: 재생 중인 발화. 취소 대상 식별에 쓴다.
        self._speaking_id: str | None = None
        self._speak_thread: threading.Thread | None = None
        self._lock = threading.Lock()

    # -- 설정 -------------------------------------------------------------

    def _speech_request(self, text: str) -> SpeechRequest:
        c = self.config
        return SpeechRequest(
            text=text,
            voice=c["voice"],
            speed=float(c["speed"]),
            steps=int(c["steps"]),
            fx=FxConfig(
                preset=VoicePreset(c["preset"]),
                pitch_factor=float(c["pitchFactor"]),
                intensity=float(c["fxIntensity"]),
            ),
        )

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
        #   2.4절: 메뉴바의 마이크 사용 표시(주황 점)가 사라져야 한다.
        self.wake_enabled = False
        self.ch.log("웨이크워드 대기 중지 (스텁)")

    def _on_listen_start(self, _cmd: dict[str, Any]) -> None:
        # TODO(M1): 발화 수집. VAD 로 침묵 1.2초를 감지하면 인식으로 넘어간다.
        self.ch.speech(active=True)
        self.ch.log("발화 수집 시작 (스텁)")

    def _on_listen_stop(self, _cmd: dict[str, Any]) -> None:
        self.ch.speech(active=False)
        self.ch.transcript(
            text="(스텁) 아직 음성 인식이 붙지 않았습니다",
            confidence=0.0,
            latency_ms=0,
        )

    def _on_speak(self, cmd: dict[str, Any]) -> None:
        """말하기.

        재생은 별도 스레드에서 돈다. 명령 루프가 막히면 speak.cancel 을
        받을 수 없고, 그러면 끼어들기(2.3절)가 성립하지 않는다.
        """
        speak_id = cmd["id"]
        text = cmd["text"]

        with self._lock:
            previous = self._speak_thread
            if self._speaking_id is not None:
                self.tts.cancel()  # 앞선 발화를 밀어낸다
            self._speaking_id = speak_id

        def run() -> None:
            # 앞 발화가 완전히 끝난 뒤에 시작한다. 겹치면 출력 스트림이 둘이 되어
            # 두 목소리가 동시에 들린다 — 취소 플래그가 공유 자원이므로
            # 직렬화하지 않으면 뒤 발화가 앞 발화의 취소를 지워버린다.
            if previous is not None and previous.is_alive():
                previous.join(timeout=3.0)
            try:
                completed = self.tts.speak(
                    self._speech_request(text),
                    on_first_audio=lambda ms: self.ch.speak_begin(speak_id, ms),
                )
            except Exception as exc:
                self.ch.error("tts_failed", f"{self.tts.name}: {exc}", fatal=False)
                completed = False
            finally:
                with self._lock:
                    if self._speaking_id == speak_id:
                        self._speaking_id = None
            self.ch.speak_end(speak_id, cancelled=not completed)

        self._speak_thread = threading.Thread(target=run, daemon=True)
        self._speak_thread.start()

    def _on_speak_cancel(self, cmd: dict[str, Any]) -> None:
        with self._lock:
            current = self._speaking_id
        # id 를 지정하지 않으면 현재 발화를 끊는다 (끼어들기는 id 를 모른다).
        if current is not None and cmd.get("id") in (None, "current", current):
            self.tts.cancel()

    def _on_models_release(self, _cmd: dict[str, Any]) -> None:
        self.tts.unload()
        self.ch.model("tts", loaded=False)
        self.ch.model("stt", loaded=False)
        self.ch.log("모델 해제")

    def _on_config_set(self, cmd: dict[str, Any]) -> None:
        incoming = cmd.get("config") or {}
        self.config.update(incoming)
        self.ch.log(f"설정 갱신: {sorted(incoming.keys())}")

    def _on_metrics_request(self, _cmd: dict[str, Any]) -> None:
        # TODO(M6): psutil 로 실측 (7.2절 설정 화면의 실시간 표시).
        self.ch.metrics(rss_mb=0.0, wake_cpu_percent=0.0, last_latency_ms=None)

    def _on_shutdown(self, _cmd: dict[str, Any]) -> None:
        self.tts.cancel()
        self.running = False

    # -- 루프 -------------------------------------------------------------

    def run(self) -> None:
        self.ch.log(f"입(TTS) 뒷단: {self.tts.name}")
        self.ch.ready()
        for cmd in self.ch.commands():
            try:
                self.handle(cmd)
            except Exception as exc:  # 한 명령의 실패로 엔진을 죽이지 않는다.
                self.ch.error("handler_failed", f"{cmd.get('type')}: {exc}", fatal=False)
            if not self.running:
                break
        # 재생 중이면 끝날 때까지 잠깐 기다린다 — 말이 뚝 끊기면 이상하다.
        if self._speak_thread and self._speak_thread.is_alive():
            self._speak_thread.join(timeout=2.0)
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
