"""골리앗 음성 엔진.

  귀   openWakeWord (hey_jarvis) + Whisper medium + 환각 방지 4중 대책
  입   수퍼토닉 M1 + 자비스 프리셋, 문장 단위 스트리밍

마이크 스트림은 하나다. 웨이크워드와 발화 수집이 공유한다 — microphone.py 참고.
프로토콜(protocol.py)과 뒷단(backends.py)은 이 파일이 바뀌어도 바뀌지 않는다.
"""

from __future__ import annotations

import threading
import time
from typing import Any

import numpy as np

from .audio_fx import FxConfig, VoicePreset
from .backends import SpeechRequest, default_stt, default_tts
from .hallucination import Verdict, judge
from .microphone import Microphone, UtteranceCollector
from .protocol import Channel

#: protocol.ts 의 DEFAULT_VOICE_CONFIG 와 짝을 이룬다.
DEFAULT_CONFIG: dict[str, Any] = {
    # 입 — 10종 청취 후 확정
    "voice": "M1",
    "preset": "jarvis",
    "speed": 1.35,
    "pitchFactor": 1.07,
    "fxIntensity": 1.0,
    "steps": 8,
    # 귀 — 실측 후 확정 (medium + 힌트: CER 0.8%, RTF 0.122)
    "whisperModel": "medium",
    "language": "ko",
    "vocabularyHints": [
        "타입스크립트", "리팩터링", "useEffect", "일렉트론", "렌더러",
        "프로토콜", "웨이크워드", "커밋", "빌드", "디플로이", "비동기",
    ],
    # 웨이크워드 — 학습 전까지 hey_jarvis (9절)
    "wakeWordModel": "hey_jarvis",
    "wakeWordThreshold": 0.5,
}

#: 웨이크워드 재감지 억제 시간. 한 번 울리면 잠시 무시한다.
WAKE_COOLDOWN_SEC = 2.0
#: 발화 수집 최대 대기.
UTTERANCE_TIMEOUT_SEC = 35.0


class Engine:
    def __init__(self, channel: Channel) -> None:
        self.ch = channel
        self.config: dict[str, Any] = dict(DEFAULT_CONFIG)
        self.running = True

        self.tts = default_tts()
        self.stt = default_stt()
        self._stt_loaded = False

        self.mic = Microphone(on_error=lambda m: self.ch.log(f"마이크: {m}"))
        self.collector = UtteranceCollector(
            on_speech_change=self._on_speech_change
        )

        self._wake_model = None
        self._wake_last_fired = 0.0
        self._interrupt_vad = None
        self._interrupt_fired = False

        self._speaking_id: str | None = None
        self._speak_thread: threading.Thread | None = None
        self._listen_thread: threading.Thread | None = None
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

    def _hints(self) -> str:
        return ", ".join(self.config.get("vocabularyHints") or [])

    # -- 마이크 소비자 ------------------------------------------------------

    def _on_frame(self, frame: np.ndarray) -> None:
        """모든 마이크 프레임이 지나가는 곳. 가볍게 유지해야 한다."""
        self._detect_wake(frame)
        self._detect_interrupt(frame)
        self.collector.feed(frame)

    def _detect_wake(self, frame: np.ndarray) -> None:
        if self._wake_model is None or self.collector.is_active:
            return
        now = time.monotonic()
        if now - self._wake_last_fired < WAKE_COOLDOWN_SEC:
            return
        try:
            scores = self._wake_model.predict(frame)
        except Exception as exc:
            self.ch.log(f"웨이크워드 추론 실패: {exc}")
            return
        name = self.config["wakeWordModel"]
        score = float(scores.get(name, 0.0))
        if score >= float(self.config["wakeWordThreshold"]):
            self._wake_last_fired = now
            self.ch.wake(score)

    def _detect_interrupt(self, frame: np.ndarray) -> None:
        """말하는 중 사용자 발화 감지 (2.3절 끼어들기).

        끼어들기 활성 여부는 메인 프로세스가 판단한다 — 출력 장치를 아는 쪽이
        거기다. 엔진은 사실만 보고한다.
        """
        with self._lock:
            speaking = self._speaking_id is not None
        if not speaking:
            self._interrupt_fired = False
            return
        if self._interrupt_fired:
            return
        if self._interrupt_vad is None:
            from openwakeword.vad import VAD

            self._interrupt_vad = VAD()
        try:
            # int16 그대로. 정규화하면 점수가 0.03 수준으로 떨어진다.
            score = self._interrupt_vad.predict(frame)
            if isinstance(score, (list, tuple, np.ndarray)):
                score = float(np.max(score))
        except Exception:
            return
        if float(score) >= 0.6:
            self._interrupt_fired = True
            self.ch.speech(active=True)

    def _on_speech_change(self, active: bool) -> None:
        # 수집 중의 발화 시작/끝. 메인은 UI 반응에 쓴다.
        self.ch.speech(active=active)

    # -- 명령 처리 ---------------------------------------------------------

    def handle(self, cmd: dict[str, Any]) -> None:
        kind = cmd.get("type")
        handler = getattr(self, f"_on_{kind.replace('.', '_')}", None) if kind else None
        if handler is None:
            self.ch.error("unknown_command", f"알 수 없는 명령: {kind!r}", fatal=False)
            return
        handler(cmd)

    def _on_wake_enable(self, _cmd: dict[str, Any]) -> None:
        if self._wake_model is None:
            from openwakeword.model import Model

            t0 = time.perf_counter()
            self._wake_model = Model(
                wakeword_models=[self.config["wakeWordModel"]],
                inference_framework="onnx",
            )
            self.ch.log(
                f"웨이크워드 로드 {int((time.perf_counter()-t0)*1000)}ms "
                f"({self.config['wakeWordModel']})"
            )
        if not self.mic.is_open:
            self.mic.subscribe(self._on_frame)
            self.mic.start()
        self.ch.log("웨이크워드 대기 시작")

    def _on_wake_disable(self, _cmd: dict[str, Any]) -> None:
        """2.4절: 마이크 스트림 자체를 닫는다 — 메뉴바 주황 점이 사라져야 한다."""
        self.collector.abort()
        self.mic.unsubscribe(self._on_frame)
        self.mic.stop()
        self._wake_model = None
        self._interrupt_vad = None
        self.ch.log("웨이크워드 대기 중지 (마이크 닫힘)")

    def _on_listen_start(self, _cmd: dict[str, Any]) -> None:
        """발화 수집 시작.

        웨이크워드가 울린 뒤 이 명령이 오기까지 시간이 걸린다. 그동안의 소리는
        링 버퍼에 남아 있으므로 되돌아가 주워야 첫 음절을 잃지 않는다.
        """
        if not self.mic.is_open:
            self.mic.subscribe(self._on_frame)
            self.mic.start()
        if self.collector.is_active:
            return

        self.collector.begin(preroll=self.mic.preroll())
        self._listen_thread = threading.Thread(target=self._collect, daemon=True)
        self._listen_thread.start()

    def _on_listen_stop(self, _cmd: dict[str, Any]) -> None:
        self.collector.abort()

    def _collect(self) -> None:
        """발화가 끝나기를 기다렸다가 인식하고 판정한다."""
        utterance = self.collector.wait(UTTERANCE_TIMEOUT_SEC)
        if utterance is None:
            self.ch.transcript("", 0.0, 0, discarded=True, reason="silence")
            return

        try:
            if not self._stt_loaded:
                ms = self.stt.load(self.config["whisperModel"])
                self._stt_loaded = True
                self.ch.model("stt", loaded=True, load_ms=ms)

            result = self.stt.transcribe(
                utterance.audio,
                language=self.config["language"],
                hints=self._hints(),
            )
        except Exception as exc:
            self.ch.error("stt_failed", f"{self.stt.name}: {exc}", fatal=False)
            return

        verdict = judge(
            result.text,
            duration_sec=utterance.duration_sec,
            speech_ratio=utterance.speech_ratio,
            no_speech_prob=result.no_speech_prob,
            avg_logprob=result.avg_logprob,
            compression_ratio=result.compression_ratio,
        )

        if verdict.verdict is Verdict.ACCEPT:
            self.ch.transcript(
                result.text,
                confidence=float(result.avg_logprob or 0.0),
                latency_ms=result.latency_ms,
            )
        else:
            self.ch.log(
                f"폐기({verdict.reason}) {utterance.duration_sec:.1f}s "
                f"발화비율 {utterance.speech_ratio:.0%} · {result.text[:40]!r}"
            )
            self.ch.transcript(
                "" if verdict.verdict is Verdict.DISCARD else result.text,
                confidence=float(result.avg_logprob or 0.0),
                latency_ms=result.latency_ms,
                discarded=True,
                reason=verdict.reason,
            )

    def _on_speak(self, cmd: dict[str, Any]) -> None:
        """말하기. 재생은 별도 스레드에서 — 명령 루프가 막히면 취소를 못 받는다."""
        speak_id = cmd["id"]
        text = cmd["text"]

        with self._lock:
            previous = self._speak_thread
            if self._speaking_id is not None:
                self.tts.cancel()
            self._speaking_id = speak_id
            self._interrupt_fired = False

        def run() -> None:
            # 앞 발화가 완전히 끝난 뒤 시작한다. 겹치면 스트림이 둘이 되어
            # 두 목소리가 동시에 들린다.
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
        if current is not None and cmd.get("id") in (None, "current", current):
            self.tts.cancel()

    def _on_models_release(self, _cmd: dict[str, Any]) -> None:
        self.tts.unload()
        if self._stt_loaded:
            self.stt.unload()
            self._stt_loaded = False
        self.ch.model("tts", loaded=False)
        self.ch.model("stt", loaded=False)
        self.ch.log("모델 해제")

    def _on_config_set(self, cmd: dict[str, Any]) -> None:
        incoming = cmd.get("config") or {}
        # 모델을 바꾸면 다시 올려야 한다.
        if "whisperModel" in incoming and incoming["whisperModel"] != self.config.get(
            "whisperModel"
        ):
            self.stt.unload()
            self._stt_loaded = False
        self.config.update(incoming)
        self.ch.log(f"설정 갱신: {sorted(incoming.keys())}")

    def _on_metrics_request(self, _cmd: dict[str, Any]) -> None:
        try:
            import psutil

            rss = psutil.Process().memory_info().rss / (1024 * 1024)
        except Exception:
            rss = 0.0
        self.ch.metrics(rss_mb=round(rss, 1), wake_cpu_percent=0.0, last_latency_ms=None)

    def _on_shutdown(self, _cmd: dict[str, Any]) -> None:
        self.tts.cancel()
        # 수집 중이면 끊는다. 이미 인식 단계라면 run() 이 결과를 기다린다.
        if self.collector.is_active:
            self.collector.abort()
        self.running = False

    # -- 루프 -------------------------------------------------------------

    def run(self) -> None:
        self.ch.log(f"귀: {self.stt.name} · 입: {self.tts.name}")
        self.ch.ready()
        for cmd in self.ch.commands():
            try:
                self.handle(cmd)
            except Exception as exc:
                self.ch.error("handler_failed", f"{cmd.get('type')}: {exc}", fatal=False)
            if not self.running:
                break
        # 인식이 진행 중이면 결과를 잃지 않도록 기다린다. 종료 명령이
        # 인식보다 먼저 도착하면 transcript 가 사라진다.
        if self._listen_thread and self._listen_thread.is_alive():
            self._listen_thread.join(timeout=15.0)
        if self._speak_thread and self._speak_thread.is_alive():
            self._speak_thread.join(timeout=2.0)
        self.mic.stop()
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
