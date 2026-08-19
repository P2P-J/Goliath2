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
from .hallucination import Verdict, judge, prejudge
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
        # 웨이크워드가 맨 앞에 온다 — 인식률이 여기 달려 있다.
        "골리앗", "골리앗 온라인",
        "타입스크립트", "리팩터링", "useEffect", "일렉트론", "렌더러",
        "프로토콜", "웨이크워드", "커밋", "빌드", "디플로이", "비동기",
    ],
    # 웨이크워드
    #
    # "골리앗 온라인" 은 openWakeWord 사전학습 모델에 없다. 커스텀 학습에는
    # PyTorch 와 수 시간이 필요하다. 대신 이미 돌고 있는 Whisper 를 감지기로
    # 쓴다 — 대기 중에도 발화를 인식하고 글자에 "골리앗" 이 있으면 깨어난다.
    # 실측: 합성 음성 15종에서 15/15 인식.
    #
    # hey_jarvis 는 즉시 반응하는 빠른 경로로 함께 둔다.
    "wakeWords": ["골리앗"],
    "wakeWordModel": "hey_jarvis",
    "wakeWordThreshold": 0.5,
    #: 대기 중 인식할 발화의 최대 길이. 웨이크워드는 짧다 —
    #: 긴 발화까지 인식하면 옆에서 통화만 해도 계속 인식기가 돈다.
    "wakeMaxSpeechSec": 10.0,
    # 끼어들기 (5.3절)
    #   에어팟   켬 — 스피커 소리가 마이크로 거의 새지 않는다
    #   내장 스피커 끔 — 자기 목소리를 되듣고 스스로 끊는다
    # None 이면 출력 장치를 보고 자동 판단한다.
    "interruptEnabled": None,
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

        #: 마이크가 열려 웨이크워드를 기다리는 중.
        self._armed = False
        #: 청취 창이 열려 있다 — 웨이크워드 없이 바로 명령으로 받는다.
        self._awake = False
        self._loop_thread: threading.Thread | None = None

        self._speaking_id: str | None = None
        self._speak_thread: threading.Thread | None = None
        self._loop_thread: threading.Thread | None = None
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
        if self._interrupt_fired or not self._interrupt_allowed():
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

    def _interrupt_allowed(self) -> bool:
        """끼어들기를 켤지 판단한다 (5.3절).

        내장 스피커로 말하면 그 소리가 마이크로 그대로 들어온다. 그러면
        골리앗이 자기 목소리를 사용자 발화로 오인해 스스로 말을 끊는다.
        헤드폰·에어팟이면 새는 양이 적어 안전하다.
        """
        setting = self.config.get("interruptEnabled")
        if setting is not None:
            return bool(setting)
        return self._output_is_headphones()

    def _output_is_headphones(self) -> bool:
        """기본 출력이 헤드폰/블루투스인지. 판단이 안 서면 안전하게 False."""
        try:
            import sounddevice as sd

            name = str(sd.query_devices(kind="output")["name"]).lower()
        except Exception:
            return False
        # 내장 스피커는 이름에 speaker/내장 이 들어간다.
        if "speaker" in name or "내장" in name or "macbook" in name:
            return False
        return any(k in name for k in ("airpod", "headphone", "buds", "bluetooth", "헤드", "이어"))

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
        self._armed = True
        if self._loop_thread is None or not self._loop_thread.is_alive():
            self._loop_thread = threading.Thread(target=self._listen_loop, daemon=True)
            self._loop_thread.start()
        self.ch.log(f"대기 시작 — 웨이크워드 {self.config['wakeWords']}")

    def _on_wake_disable(self, _cmd: dict[str, Any]) -> None:
        """2.4절: 마이크 스트림 자체를 닫는다 — 메뉴바 주황 점이 사라져야 한다."""
        self._armed = False
        self._awake = False
        self.collector.abort()
        self.mic.unsubscribe(self._on_frame)
        self.mic.stop()
        self._wake_model = None
        self._interrupt_vad = None
        self.ch.log("웨이크워드 대기 중지 (마이크 닫힘)")

    def _on_listen_start(self, _cmd: dict[str, Any]) -> None:
        """청취 창을 연다 — 웨이크워드 없이 바로 명령으로 받는다.

        수집은 대기 중에도 계속 돌고 있다. 이 명령은 "다음 발화를 명령으로
        취급하라"는 뜻이며, 웨이크워드 감지 후와 전역 단축키에서 온다.
        """
        self._awake = True
        if not self.mic.is_open:
            self.mic.subscribe(self._on_frame)
            self.mic.start()
        if not self._armed:
            self._armed = True
            if self._loop_thread is None or not self._loop_thread.is_alive():
                self._loop_thread = threading.Thread(target=self._listen_loop, daemon=True)
                self._loop_thread.start()

    def _on_listen_stop(self, _cmd: dict[str, Any]) -> None:
        """청취 창을 닫는다. 대기는 계속된다."""
        self._awake = False

    def _listen_loop(self) -> None:
        """마이크가 열려 있는 동안 발화를 계속 모으고 판정한다.

        대기 중  — 인식해서 웨이크워드가 있으면 깨운다
        청취 중  — 그대로 명령으로 올린다
        """
        while self._armed:
            if not self.collector.is_active:
                self.collector.begin(preroll=self.mic.take_preroll())
            utterance = self.collector.wait(UTTERANCE_TIMEOUT_SEC)
            if utterance is None or not self._armed:
                continue

            pre = prejudge(
                duration_sec=utterance.duration_sec,
                speech_sec=utterance.speech_sec,
                speech_ratio=utterance.speech_ratio,
            )
            if pre.verdict is not Verdict.ACCEPT:
                if self._awake:
                    self.ch.transcript("", 0.0, 0, discarded=True, reason=pre.reason)
                continue

            awake = self._awake
            # 대기 중에는 짧은 발화만 인식한다. 옆에서 통화만 해도 인식기가
            # 계속 도는 것을 막는다.
            if not awake and utterance.speech_sec > float(self.config["wakeMaxSpeechSec"]):
                continue

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
                continue

            verdict = judge(
                result.text,
                duration_sec=utterance.duration_sec,
                speech_ratio=utterance.speech_ratio,
                no_speech_prob=result.no_speech_prob,
                avg_logprob=result.avg_logprob,
                compression_ratio=result.compression_ratio,
            )

            if not awake:
                # 대기 중 — 웨이크워드가 있어야만 깨운다.
                command = self._strip_wake_word(result.text)
                if command is None:
                    continue
                self._awake = True
                self.ch.wake(1.0)
                if command.strip():
                    # "골리앗 온라인 오늘 일정 알려줘" 처럼 명령이 붙어 있으면
                    # 바로 올린다. 이름만 불렀으면 다음 발화를 기다린다.
                    self.ch.transcript(
                        command.strip(),
                        confidence=float(result.avg_logprob or 0.0),
                        latency_ms=result.latency_ms,
                    )
                continue

            if verdict.verdict is Verdict.ACCEPT:
                self.ch.transcript(
                    result.text,
                    confidence=float(result.avg_logprob or 0.0),
                    latency_ms=result.latency_ms,
                )
            else:
                self.ch.log(
                    f"폐기({verdict.reason}) 발화 {utterance.speech_sec:.1f}s · {result.text[:40]!r}"
                )
                self.ch.transcript(
                    "" if verdict.verdict is Verdict.DISCARD else result.text,
                    confidence=float(result.avg_logprob or 0.0),
                    latency_ms=result.latency_ms,
                    discarded=True,
                    reason=verdict.reason,
                )

    def _strip_wake_word(self, text: str) -> str | None:
        """웨이크워드가 있으면 그 뒤를 돌려준다. 없으면 None.

        "골리앗 온라인 오늘 일정 알려줘" → "오늘 일정 알려줘"
        "골리앗 온라인"                  → ""
        "오늘 날씨 어때"                 → None
        """
        squeezed = text.replace(" ", "")
        for word in self.config.get("wakeWords") or ():
            key = word.replace(" ", "")
            index = squeezed.find(key)
            if index < 0:
                continue
            # 원문에서 대응 위치를 찾는다 — 공백을 지운 인덱스를 되돌린다.
            seen = 0
            for pos, ch in enumerate(text):
                if not ch.isspace():
                    if seen == index + len(key):
                        rest = text[pos:]
                        # "온라인" 같은 뒤따르는 기동어는 명령이 아니다.
                        for filler in ("온라인", "온 라인", "online"):
                            stripped = rest.lstrip(" ,.")
                            if stripped.lower().startswith(filler):
                                rest = stripped[len(filler):]
                                break
                        return rest.lstrip(" ,.")
                    seen += 1
            return ""
        return None

    def _on_speak(self, cmd: dict[str, Any]) -> None:
        """말하기. 재생은 별도 스레드에서 — 명령 루프가 막히면 취소를 못 받는다."""
        speak_id = cmd["id"]
        text = cmd["text"]
        queue = bool(cmd.get("queue"))

        with self._lock:
            previous = self._speak_thread
            # queue 면 앞 발화를 끝까지 두고 뒤에 붙는다. Claude 응답을
            # 문장 단위로 흘려보낼 때 쓴다 — 매번 취소하면 첫 문장만 들린다.
            if self._speaking_id is not None and not queue:
                self.tts.cancel()
            self._speaking_id = speak_id
            self._interrupt_fired = False

        def run() -> None:
            # 앞 발화가 완전히 끝난 뒤 시작한다. 겹치면 스트림이 둘이 되어
            # 두 목소리가 동시에 들린다.
            if previous is not None and previous.is_alive():
                previous.join(timeout=60.0 if queue else 3.0)
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
        self._armed = False
        self._awake = False
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
        if self._loop_thread and self._loop_thread.is_alive():
            self._loop_thread.join(timeout=15.0)
        if self._speak_thread and self._speak_thread.is_alive():
            self._speak_thread.join(timeout=2.0)

        # 정리 순서가 중요하다. 마이크를 먼저 닫아 콜백을 멈추고, 그다음
        # ONNX 세션 참조를 놓는다. 인터프리터 종료 중에 데몬 스레드가 살아
        # 있는 채로 세션이 파괴되면 libc++ 가 recursive_mutex 오류로 abort 한다.
        self.mic.stop()
        self.collector.abort()
        self._wake_model = None
        self._interrupt_vad = None
        try:
            self.tts.unload()
            if self._stt_loaded:
                self.stt.unload()
        except Exception:
            pass
        import gc

        gc.collect()
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
