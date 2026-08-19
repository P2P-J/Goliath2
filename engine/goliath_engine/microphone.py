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

#: Silero VAD 의 내부 조각 크기. 1280 을 정확히 2 로 나눈다.
#: 480(기본값)은 1280 을 나누지 못해 마지막 조각이 320 으로 잘리고,
#: predict 가 조각별 점수를 평균내므로 점수가 끌려 내려간다.
VAD_FRAME_SIZE = 640

#: 히스테리시스. 프레임 하나로 상태가 뒤집히면 주변 소음이 산발적으로 발화로
#: 잡혀 침묵 카운터를 계속 리셋한다 — 발화가 끝나지 않고, 대부분 소음인
#: 오디오가 인식기로 넘어간다.
VAD_WINDOW = 3          # 최근 몇 프레임을 보는가
VAD_VOTES = 2           # 그중 몇 개가 발화여야 발화로 보는가

#: 발화 종료 판정. "연속 무음"이 아니라 "최근 창의 발화 밀도"로 본다.
#:
#: 연속 무음을 요구하면 산발적 오탐 하나가 카운터를 리셋해 발화가 끝나지
#: 않는다. 조용한 방에서는 오탐이 0 이라 드러나지 않지만, 소음이 있는 곳에서는
#: 1.5초 발화가 8~20초로 늘어난다. 밀도로 보면 오탐 하나쯤은 무시된다.
TAIL_MAX_SPEECH = 1     # 창 안에 발화가 이보다 많으면 아직 말하는 중

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
    duration_sec: float     # 프리롤을 포함한 전체 길이
    speech_sec: float       # 발화로 판정된 구간의 길이 — 판정은 이걸 본다
    speech_ratio: float     # 프리롤 이후 프레임 중 발화 비율
    clipped_ratio: float    # 포화된 프레임 비율. 높으면 마이크 게인이 과하다


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
        max_sec: float = 20.0,
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
        self._votes: deque[bool] = deque(maxlen=VAD_WINDOW)
        self._tail: deque[bool] = deque(maxlen=self._silence_frames)
        self._fed = 0
        self._speech_frames = 0
        self._clipped = 0
        self._speaking = False
        self._active = False
        self._done: Utterance | None = None
        self._lock = threading.Lock()

    def begin(self, preroll: np.ndarray | None = None) -> None:
        """수집을 시작한다. preroll 이 있으면 앞에 붙인다."""
        with self._lock:
            self._frames = []
            self._votes.clear()
            self._tail.clear()
            self._fed = 0
            self._speech_frames = 0
            self._clipped = 0
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
            self._fed += 1

            if np.abs(frame).max() >= 32000:
                self._clipped += 1

            self._votes.append(self._raw_speech(frame))
            # 히스테리시스: 최근 창에서 과반이 발화여야 발화로 본다.
            is_speech = sum(self._votes) >= VAD_VOTES
            self._tail.append(is_speech)

            if is_speech:
                self._speech_frames += 1
                if not self._speaking:
                    self._speaking = True
                    self._on_speech_change(True)

            # 종료: 최근 창(1.2초)의 발화 밀도가 충분히 낮아지면 끝난다.
            # 창이 다 차기 전에는 판단하지 않는다.
            quiet = (
                len(self._tail) == self._tail.maxlen
                and sum(self._tail) <= TAIL_MAX_SPEECH
            )
            if self._speaking and quiet:
                self._finish()
            elif self._fed >= self._max_frames:
                self._finish()

    def _raw_speech(self, frame: np.ndarray) -> bool:
        """이 프레임 하나에 대한 VAD 판정.

        openWakeWord 의 VAD 는 int16 을 먹는다 — 내부에서 /32767 을 한다.
        정규화해 넘기면 이중 정규화가 되어 점수가 0.99 → 0.03 으로 떨어진다.

        frame_size 는 1280 을 나누어떨어지게 준다. 기본값 480 은 마지막 조각이
        320 으로 잘리고, predict 가 조각별 점수를 평균내므로 점수가 낮게 나온다.
        """
        try:
            score = self._vad.predict(frame, frame_size=VAD_FRAME_SIZE)
            if isinstance(score, (list, tuple, np.ndarray)):
                score = float(np.max(score))
            return float(score) >= self._threshold
        except Exception:
            # VAD 가 실패하면 에너지로 대충 판단한다 — 수집이 멈추는 것보다 낫다.
            return float(np.abs(frame).mean()) > 400

    def _finish(self) -> None:
        audio = np.concatenate(self._frames) if self._frames else np.zeros(0, np.int16)
        self._done = Utterance(
            audio=audio.astype(np.float32) / 32768.0,
            duration_sec=len(audio) / SAMPLE_RATE,
            speech_sec=self._speech_frames * FRAME_SAMPLES / SAMPLE_RATE,
            speech_ratio=(self._speech_frames / self._fed) if self._fed else 0.0,
            clipped_ratio=(self._clipped / self._fed) if self._fed else 0.0,
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
            self._votes.clear()
            self._tail.clear()
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
