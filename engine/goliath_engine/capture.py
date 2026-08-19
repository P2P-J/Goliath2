"""마이크 캡처 — 음향 반향 제거(AEC)를 켠 입력.

왜 필요한가
  스피커로 나간 골리앗의 목소리가 마이크로 그대로 돌아온다. 그것을 수집하면
  자기 말을 사용자 명령으로 인식해 스스로에게 답하고, 그 답이 다시 들어와
  끝없이 돈다.

  클로드 음성 모드·Siri·FaceTime 이 이 문제를 겪지 않는 이유는 AEC 가 들어
  있기 때문이다. 스피커로 내보낸 신호를 알고 있으니 마이크 입력에서 빼버린다.
  PortAudio 로 여는 생 마이크에는 그 처리가 없다.

  macOS 에는 Apple 의 Voice Processing I/O 가 있다. AVAudioEngine 의 입력
  노드에 켜면 AEC 와 함께 잡음 억제·자동 게인 조절도 따라온다.

실측 (M2 Air, 스피커 재생, 조용할 때 대비 누출 배수)
  AEC 끔  15.3배   RMS 0.01290
  AEC 켬   6.8배   RMS 0.00161   ← 절대량 8배 감소

  완전히 없어지지는 않는다. 그래서 "말할 때 귀를 닫는" 방어와 "한 말과
  겹치면 버리는" 방어를 함께 둔다.
"""

from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from typing import Callable

import numpy as np

SAMPLE_RATE = 16_000


def _lowpass_kernel(taps: int = 31, cutoff_hz: float = 7000.0, source_hz: float = 48_000.0):
    """데시메이션 전에 걸 저역 통과 필터 (윈도우 싱크).

    그냥 3개마다 하나씩 뽑으면 8kHz 위 성분이 접혀 들어와(에일리어싱) 인식이
    나빠진다. 미리 잘라내야 한다.
    """
    n = np.arange(taps) - (taps - 1) / 2
    fc = cutoff_hz / source_hz
    kernel = np.sinc(2 * fc * n) * np.hamming(taps)
    return (kernel / kernel.sum()).astype(np.float32)


class Capture(ABC):
    """마이크에서 16kHz 모노 int16 프레임을 뽑아 콜백으로 넘긴다."""

    name: str = "abstract"
    #: AEC 가 걸려 있는가. 말하는 중 귀를 얼마나 닫을지 판단에 쓴다.
    has_aec: bool = False

    @abstractmethod
    def start(self, on_samples: Callable[[np.ndarray], None]) -> None: ...

    @abstractmethod
    def stop(self) -> None: ...


class VoiceProcessingCapture(Capture):
    """macOS AVAudioEngine + Voice Processing. AEC·잡음억제·AGC 포함."""

    name = "avfoundation-vp"
    has_aec = True

    def __init__(self) -> None:
        self._engine = None
        self._input = None
        self._tap = None          # 블록 참조를 살려 둬야 한다
        self._tail = np.zeros(0, dtype=np.float32)
        self._kernel: np.ndarray | None = None
        self._decim = 3
        self._lock = threading.Lock()

    @staticmethod
    def is_available() -> bool:
        try:
            import AVFoundation  # noqa: F401
        except Exception:
            return False
        return True

    def start(self, on_samples: Callable[[np.ndarray], None]) -> None:
        import AVFoundation as AV

        engine = AV.AVAudioEngine.alloc().init()
        node = engine.inputNode()

        # 엔진을 시작하기 전에 켜야 한다. 켜면 입력 형식이 바뀐다.
        ok, err = node.setVoiceProcessingEnabled_error_(True, None)
        if not ok:
            raise RuntimeError(f"Voice Processing 을 켤 수 없습니다: {err}")

        fmt = node.inputFormatForBus_(0)
        source_hz = float(fmt.sampleRate())
        self._decim = max(1, int(round(source_hz / SAMPLE_RATE)))
        self._kernel = _lowpass_kernel(source_hz=source_hz)

        def tap(buf, _when) -> None:
            try:
                count = buf.frameLength()
                if not count:
                    return
                channels = buf.floatChannelData()
                # 비인터리브 — 채널 0 만 쓴다.
                mono = np.frombuffer(
                    channels[0].as_buffer(count), dtype=np.float32
                ).copy()
                self._push(mono, on_samples)
            except Exception:
                # 오디오 스레드에서 예외를 올리면 스트림이 죽는다.
                pass

        self._tap = tap
        node.installTapOnBus_bufferSize_format_block_(0, 2048, fmt, tap)
        engine.prepare()
        ok, err = engine.startAndReturnError_(None)
        if not ok:
            raise RuntimeError(f"오디오 엔진을 시작할 수 없습니다: {err}")

        self._engine, self._input = engine, node

    def _push(self, mono: np.ndarray, on_samples: Callable[[np.ndarray], None]) -> None:
        """48kHz float32 → 16kHz int16. 필터를 걸고 3개마다 하나씩 뽑는다."""
        with self._lock:
            buf = np.concatenate([self._tail, mono])
            kernel = self._kernel
            if kernel is None:
                return
            usable = len(buf) - len(kernel) + 1
            if usable <= 0:
                self._tail = buf
                return
            filtered = np.convolve(buf, kernel, mode="valid")
            decimated = filtered[:: self._decim]
            # 다음 호출에서 이어 붙일 꼬리를 남긴다.
            consumed = len(decimated) * self._decim
            self._tail = buf[consumed:]

        if len(decimated):
            on_samples(np.clip(decimated * 32767.0, -32768, 32767).astype(np.int16))

    def stop(self) -> None:
        engine, node = self._engine, self._input
        self._engine = self._input = None
        try:
            if node is not None:
                node.removeTapOnBus_(0)
            if engine is not None:
                engine.stop()
        finally:
            self._tap = None
            self._tail = np.zeros(0, dtype=np.float32)


class SoundDeviceCapture(Capture):
    """PortAudio 생 입력. AEC 가 없다 — macOS 가 아닌 환경의 폴백."""

    name = "sounddevice"
    has_aec = False

    def __init__(self, blocksize: int) -> None:
        self._stream = None
        self._blocksize = blocksize

    @staticmethod
    def is_available() -> bool:
        try:
            import sounddevice  # noqa: F401
        except Exception:
            return False
        return True

    def start(self, on_samples: Callable[[np.ndarray], None]) -> None:
        import sounddevice as sd

        def callback(indata, _frames, _time, _status) -> None:
            on_samples(indata[:, 0].copy())

        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=self._blocksize,
            callback=callback,
        )
        self._stream.start()

    def stop(self) -> None:
        stream, self._stream = self._stream, None
        if stream is not None:
            stream.stop()
            stream.close()


def default_capture(blocksize: int) -> Capture:
    """AEC 가 되는 것을 먼저 고른다."""
    if VoiceProcessingCapture.is_available():
        return VoiceProcessingCapture()
    if SoundDeviceCapture.is_available():
        return SoundDeviceCapture(blocksize)
    raise RuntimeError("마이크를 열 수 있는 뒷단이 없습니다")
