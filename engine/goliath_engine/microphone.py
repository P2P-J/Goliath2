"""마이크 입력 — 웨이크워드와 발화 수집이 공유하는 단일 스트림.

왜 하나인가
  웨이크워드(상시)와 Whisper(발화 중)가 각자 스트림을 열면 장치 전환·권한·
  전력에서 전부 문제가 생긴다. 특히 macOS 는 마이크 사용 중 메뉴바에 주황 점을
  띄우는데, 스트림이 둘이면 2.4절의 "비활성 시 주황 점이 사라져야 한다"를
  보장하기 어렵다. 스트림은 하나, 소비자는 여럿이다.

샘플레이트
  16kHz 모노. openWakeWord 와 Whisper 가 둘 다 이 형식을 먹으므로 변환이 없다.

프레임 크기
  1280 샘플 = 80ms. openWakeWord 가 권장하는 단위다.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass
from queue import Empty, Queue
from typing import Callable

import numpy as np

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 1280          # 80ms
FRAME_MS = FRAME_SAMPLES * 1000 // SAMPLE_RATE

#: 웨이크워드가 울린 시점 이전 구간을 얼마나 보관할지.
#: "골리앗 온라인, 오늘 일정 알려줘" 처럼 이어 말하면 명령의 앞부분이
#: 이미 지나간 뒤에 감지되므로, 되돌아가 주워야 첫 음절을 잃지 않는다.
PREROLL_SEC = 2.0


class Microphone:
    """마이크 스트림의 생명주기와 프레임 분배를 맡는다.

    오디오 콜백은 실시간 스레드에서 돈다 — 무거운 일을 하면 프레임이 깨진다.
    콜백은 큐에 넣기만 하고, 실제 처리는 작업 스레드에서 한다.
    """

    def __init__(self, on_error: Callable[[str], None] | None = None) -> None:
        self._stream = None
        self._queue: Queue[np.ndarray] = Queue(maxsize=64)
        self._worker: threading.Thread | None = None
        self._running = threading.Event()
        self._consumers: list[Callable[[np.ndarray], None]] = []
        self._preroll: deque[np.ndarray] = deque(
            maxlen=int(PREROLL_SEC * SAMPLE_RATE / FRAME_SAMPLES)
        )
        self._lock = threading.Lock()
        self._on_error = on_error or (lambda _msg: None)
        self._dropped = 0

    # -- 소비자 --------------------------------------------------------

    def subscribe(self, consumer: Callable[[np.ndarray], None]) -> None:
        """프레임을 받을 소비자를 등록한다. int16 ndarray, 1280 샘플."""
        with self._lock:
            self._consumers.append(consumer)

    def unsubscribe(self, consumer: Callable[[np.ndarray], None]) -> None:
        with self._lock:
            if consumer in self._consumers:
                self._consumers.remove(consumer)

    def preroll(self) -> np.ndarray:
        """최근 PREROLL_SEC 구간. 웨이크워드 감지 직후 되돌아가 주울 때 쓴다."""
        with self._lock:
            frames = list(self._preroll)
        return np.concatenate(frames) if frames else np.zeros(0, dtype=np.int16)

    # -- 생명주기 ------------------------------------------------------

    @property
    def is_open(self) -> bool:
        return self._stream is not None

    def start(self) -> None:
        if self._stream is not None:
            return
        import sounddevice as sd

        def callback(indata, _frames, _time, status) -> None:
            if status:
                # 언더런/오버런. 흔하고 치명적이지 않으므로 로그만.
                self._on_error(f"오디오 상태: {status}")
            try:
                self._queue.put_nowait(indata[:, 0].copy())
            except Exception:
                # 큐가 찼다 — 소비자가 느리다. 프레임을 버리는 것이
                # 콜백을 막는 것보다 낫다.
                self._dropped += 1

        self._running.set()
        self._worker = threading.Thread(target=self._pump, daemon=True)
        self._worker.start()

        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=FRAME_SAMPLES,
            callback=callback,
        )
        self._stream.start()

    def stop(self) -> None:
        """스트림을 완전히 닫는다.

        2.4절: 비활성 시 마이크 스트림 자체를 닫아야 메뉴바의 주황 점이 사라진다.
        일시정지가 아니라 close 여야 한다.
        """
        self._running.clear()
        stream, self._stream = self._stream, None
        if stream is not None:
            stream.stop()
            stream.close()
        if self._worker is not None:
            self._worker.join(timeout=1.0)
            self._worker = None
        with self._lock:
            self._preroll.clear()

    def _pump(self) -> None:
        while self._running.is_set():
            try:
                frame = self._queue.get(timeout=0.1)
            except Empty:
                continue
            with self._lock:
                self._preroll.append(frame)
                consumers = list(self._consumers)
            for consume in consumers:
                try:
                    consume(frame)
                except Exception as exc:
                    self._on_error(f"소비자 실패: {exc}")

    @property
    def dropped_frames(self) -> int:
        return self._dropped


# ---------------------------------------------------------------------------
# 발화 수집
# ---------------------------------------------------------------------------


@dataclass
class Utterance:
    audio: np.ndarray       # float32, 16kHz, -1.0~1.0
    duration_sec: float
    speech_ratio: float     # 발화로 판정된 프레임 비율


class UtteranceCollector:
    """VAD 로 발화의 시작과 끝을 잡아 오디오를 모은다.

    기획서 8.5절 환각 방지 ①: "VAD 필터로 무음 구간 제거".
    Whisper 는 무음을 먹으면 없는 말을 지어낸다. 발화 구간만 넘기는 것이
    가장 효과적인 1차 방어다.

    openWakeWord 에 실려 오는 Silero VAD 를 쓴다 — 별도 의존성이 없다.
    """

    def __init__(
        self,
        *,
        silence_ms: int = 1200,
        max_sec: float = 30.0,
        threshold: float = 0.5,
        on_speech_change: Callable[[bool], None] | None = None,
    ) -> None:
        from openwakeword.vad import VAD

        self._vad = VAD()
        self._threshold = threshold
        self._silence_frames = max(1, silence_ms // FRAME_MS)
        self._max_frames = int(max_sec * SAMPLE_RATE / FRAME_SAMPLES)
        self._on_speech_change = on_speech_change or (lambda _active: None)

        self._frames: list[np.ndarray] = []
        self._speech_flags: list[bool] = []
        self._trailing_silence = 0
        self._speaking = False
        self._active = False
        self._done: Utterance | None = None
        self._lock = threading.Lock()

    def begin(self, preroll: np.ndarray | None = None) -> None:
        """수집을 시작한다. preroll 이 있으면 앞에 붙인다."""
        with self._lock:
            self._frames = []
            self._speech_flags = []
            self._trailing_silence = 0
            self._speaking = False
            self._active = True
            self._done = None
            self._vad.reset_states()
            if preroll is not None and len(preroll) > 0:
                self._frames.append(preroll)

    def feed(self, frame: np.ndarray) -> None:
        """마이크 프레임 하나를 넣는다. Microphone.subscribe 에 물린다."""
        with self._lock:
            if not self._active:
                return

            self._frames.append(frame)
            is_speech = self._is_speech(frame)
            self._speech_flags.append(is_speech)

            if is_speech:
                self._trailing_silence = 0
                if not self._speaking:
                    self._speaking = True
                    self._on_speech_change(True)
            else:
                self._trailing_silence += 1

            ended = self._speaking and self._trailing_silence >= self._silence_frames
            too_long = len(self._frames) >= self._max_frames
            if ended or too_long:
                self._finish()

    def _is_speech(self, frame: np.ndarray) -> bool:
        """openWakeWord 의 VAD 는 int16 을 먹는다. 정규화하면 안 된다.

        float32 로 정규화해 넘기면 같은 음성 구간에서 점수가 0.99 → 0.03 으로
        떨어져 임계값에 절대 닿지 못한다. 발화를 한 번도 감지하지 못하는
        조용한 실패라 알아내기 어렵다.

        입력 크기는 1280 샘플 고정이다 — 512/1024/1536/2048 은 모두 ONNX
        오류가 난다.
        """
        try:
            score = self._vad.predict(frame)
            if isinstance(score, (list, tuple, np.ndarray)):
                score = float(np.max(score))
            return float(score) >= self._threshold
        except Exception:
            # VAD 가 실패하면 에너지로 대충 판단한다 — 수집이 멈추는 것보다 낫다.
            return float(np.abs(frame).mean()) > 400

    def _finish(self) -> None:
        audio = np.concatenate(self._frames) if self._frames else np.zeros(0, np.int16)
        flags = self._speech_flags
        self._done = Utterance(
            audio=audio.astype(np.float32) / 32768.0,
            duration_sec=len(audio) / SAMPLE_RATE,
            speech_ratio=(sum(flags) / len(flags)) if flags else 0.0,
        )
        self._active = False
        if self._speaking:
            self._speaking = False
            self._on_speech_change(False)

    def take(self) -> Utterance | None:
        """완성된 발화를 꺼낸다. 아직이면 None."""
        with self._lock:
            done, self._done = self._done, None
            return done

    def abort(self) -> None:
        with self._lock:
            self._active = False
            self._frames = []
            self._speech_flags = []
            if self._speaking:
                self._speaking = False
                self._on_speech_change(False)

    @property
    def is_active(self) -> bool:
        return self._active

    def wait(self, timeout: float) -> Utterance | None:
        """발화가 끝날 때까지 기다린다. 폴링이지만 80ms 단위라 충분하다."""
        deadline = time.perf_counter() + timeout
        while time.perf_counter() < deadline:
            done = self.take()
            if done is not None:
                return done
            if not self.is_active:
                return None
            time.sleep(0.02)
        self.abort()
        return None
