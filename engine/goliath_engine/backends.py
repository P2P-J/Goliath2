"""귀(STT)와 입(TTS)의 교체 가능한 뒷단.

기획서 10절 원칙 3: "음성 엔진은 교체 가능한 부품이다."
protocol.py 가 프로세스 경계의 계약이고, 이 파일이 그 안쪽의 계약이다.

입(TTS)
  SupertonicBackend : 기본값. 로컬·무료·오프라인. 수퍼톤의 온디바이스 모델.
  SayBackend        : macOS 내장 음성. 수퍼토닉 로드 실패 시 폴백 —
                      항상 되는 것이 존재 이유다.

귀(STT)
  MlxWhisperBackend    : Apple Silicon Metal 가속. 맥에서 기본값.
  FasterWhisperBackend : CTranslate2. CPU/CUDA. 데스크톱·리눅스용.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from queue import Empty, Queue
from typing import Callable

import numpy as np

from .audio_fx import FxConfig, VoicePreset, apply_preset


# ---------------------------------------------------------------------------
# 입 (TTS)
# ---------------------------------------------------------------------------


@dataclass
class SpeechRequest:
    text: str
    voice: str = "M1"
    #: 말 속도. 수퍼토닉 기본 1.05, 대화용 1.35.
    speed: float = 1.35
    fx: FxConfig = field(default_factory=lambda: FxConfig(preset=VoicePreset.JARVIS,
                                                          pitch_factor=1.07))
    #: 품질 스텝 5~12. 높을수록 또렷하고 느리다.
    steps: int = 8


class TtsBackend(ABC):
    """텍스트를 소리로. 오디오는 이 프로세스 밖으로 나가지 않는다 (원칙 1)."""

    name: str = "abstract"

    @abstractmethod
    def is_available(self) -> bool: ...

    @abstractmethod
    def load(self) -> int:
        """모델을 올리고 걸린 시간(ms)을 돌려준다."""

    @abstractmethod
    def unload(self) -> None:
        """모델을 해제한다 (7.1절 유휴 15분·인식 비활성화)."""

    @abstractmethod
    def speak(self, request: SpeechRequest, on_first_audio: Callable[[int], None]) -> bool:
        """합성하고 재생한다. 재생 완료면 True, 취소면 False.

        on_first_audio 는 첫 소리가 스피커로 나가는 순간 호출된다 —
        발화종료→첫소리 지연 측정의 종점이다 (M1 통과 조건).
        """

    @abstractmethod
    def cancel(self) -> None:
        """재생을 즉시 중단한다. 끼어들기(2.3절)의 응답성이 여기 달려 있다."""


# 한국어 문장 분리. 종결부호를 남기고 자른다.
_SENTENCE = re.compile(r"[^.!?…\n]*[.!?…]+|[^.!?…\n]+")
#: 첫 소리를 앞당기기 위해 첫 문장이 이보다 길면 쉼표에서 한 번 더 자른다.
_FIRST_CHUNK_LIMIT = 40
#: 재생 블록 크기(프레임). 44.1kHz 에서 약 46ms — 취소 반응 시간의 상한이다.
#: 더 줄이면 반응이 빨라지지만 write 호출이 잦아진다.
_PLAYBACK_BLOCK = 2048


def split_sentences(text: str) -> list[str]:
    """문장 단위로 자른다. 첫 조각은 짧게 만들어 첫 소리를 앞당긴다."""
    parts = [s.strip() for s in _SENTENCE.findall(text)]
    parts = [s for s in parts if s]
    if not parts:
        return []

    head = parts[0]
    if len(head) > _FIRST_CHUNK_LIMIT and "," in head:
        cut = head.index(",", 0) + 1
        # 쉼표가 너무 앞이면 의미 없는 조각이 된다.
        if cut >= 8:
            parts = [head[:cut].strip(), head[cut:].strip()] + parts[1:]
    return [p for p in parts if p]


def _drain(queue: Queue, producer: threading.Thread) -> None:
    """취소된 발화의 뒷정리.

    생산자는 maxsize 가 찬 큐에 put 하며 막혀 있을 수 있다. 큐를 비워
    빠져나오게 한 뒤 회수한다. 호출자를 붙잡지 않는 것이 목적이다.
    """
    while True:
        try:
            if queue.get(timeout=2.0) is None:
                break
        except Empty:
            break
    producer.join(timeout=2.0)


class SupertonicBackend(TtsBackend):
    """수퍼톤 수퍼토닉 (온디바이스). 기본 경로.

    문장 단위로 합성해 재생 큐에 흘린다. RTF 가 0.2 남짓이라 합성이 재생을
    5배 앞서므로, 첫 문장만 만들면 이후로는 끊기지 않는다.
    """

    name = "supertonic"

    def __init__(self) -> None:
        self._tts = None
        self._sr = 44100
        self._cancel = threading.Event()
        self._styles: dict[str, object] = {}

    def is_available(self) -> bool:
        try:
            import supertonic  # noqa: F401
            import sounddevice  # noqa: F401
        except ImportError:
            return False
        return True

    def load(self) -> int:
        if self._tts is not None:
            return 0
        from supertonic import TTS

        t0 = time.perf_counter()
        self._tts = TTS()
        self._sr = self._tts.sample_rate
        return int((time.perf_counter() - t0) * 1000)

    def unload(self) -> None:
        self._tts = None
        self._styles.clear()

    def _style(self, voice: str):
        if voice not in self._styles:
            self._styles[voice] = self._tts.get_voice_style(voice)
        return self._styles[voice]

    def _synthesize(self, sentence: str, req: SpeechRequest) -> np.ndarray:
        # 후처리에서 pitch_factor 배 늘어나므로 합성 단계에서 미리 그만큼 빠르게.
        wav, _ = self._tts.synthesize(
            sentence,
            voice_style=self._style(req.voice),
            lang="ko",
            total_steps=req.steps,
            speed=req.speed * req.fx.pitch_factor,
        )
        return apply_preset(np.asarray(wav).reshape(-1), self._sr, req.fx)

    def speak(self, request: SpeechRequest, on_first_audio: Callable[[int], None]) -> bool:
        import sounddevice as sd

        sentences = split_sentences(request.text)
        if not sentences:
            return True

        self._cancel.clear()
        self.load()
        started = time.perf_counter()

        # 합성을 앞서 돌린다. maxsize 2 면 메모리를 아끼면서도 재생이 굶지 않는다.
        queue: Queue = Queue(maxsize=2)

        def produce() -> None:
            try:
                for sentence in sentences:
                    if self._cancel.is_set():
                        break
                    queue.put(self._synthesize(sentence, request))
            except Exception as exc:  # 합성 실패는 재생 쪽으로 전달한다
                queue.put(exc)
            finally:
                queue.put(None)  # 종료 표지

        producer = threading.Thread(target=produce, daemon=True)
        producer.start()

        stream = sd.OutputStream(samplerate=self._sr, channels=1, dtype="float32")
        stream.start()
        first = True
        completed = True

        try:
            while completed:
                if self._cancel.is_set():
                    completed = False
                    break
                try:
                    chunk = queue.get(timeout=0.05)
                except Empty:
                    continue
                if chunk is None:
                    break
                if isinstance(chunk, Exception):
                    raise chunk
                if first:
                    on_first_audio(int((time.perf_counter() - started) * 1000))
                    first = False

                # 한 문장을 통째로 write 하면 그 시간(수 초) 동안 블록되어
                # 취소를 확인하지 못한다. 작은 블록으로 나눠 매번 확인한다 —
                # 끼어들기(2.3절)의 응답성이 여기서 결정된다.
                for start in range(0, len(chunk), _PLAYBACK_BLOCK):
                    if self._cancel.is_set():
                        completed = False
                        break
                    stream.write(chunk[start : start + _PLAYBACK_BLOCK].reshape(-1, 1))
        finally:
            if self._cancel.is_set():
                stream.abort()  # 버퍼를 버린다 — 끼어들기는 즉시 멈춰야 한다
            else:
                stream.stop()
            stream.close()
            self._cancel.set()  # 생산자를 깨워 정리시킨다
            # 생산자가 합성 중이면 한 문장만큼(≈1초) 더 걸린다. 여기서 기다리면
            # speak.end 가 그만큼 늦어져 상태 기계의 청취 복귀가 밀린다.
            # 큐를 비우는 뒷정리는 배경에 맡기고 즉시 반환한다.
            threading.Thread(
                target=_drain, args=(queue, producer), daemon=True
            ).start()

        return completed

    def cancel(self) -> None:
        self._cancel.set()


class SayBackend(TtsBackend):
    """macOS 내장 음성. 폴백 전용 — 항상 되는 것이 존재 이유다."""

    name = "macos-say"

    def __init__(self, voice: str = "Yuna") -> None:
        self.voice = voice
        self._proc: subprocess.Popen[bytes] | None = None

    def is_available(self) -> bool:
        return shutil.which("say") is not None

    def load(self) -> int:
        return 0

    def unload(self) -> None:
        return None

    def speak(self, request: SpeechRequest, on_first_audio: Callable[[int], None]) -> bool:
        t0 = time.perf_counter()
        self._proc = subprocess.Popen(
            ["say", "-v", self.voice, "-r", str(int(180 * request.speed)), request.text]
        )
        on_first_audio(int((time.perf_counter() - t0) * 1000))
        code = self._proc.wait()
        self._proc = None
        return code == 0

    def cancel(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()


def select_tts(candidates: list[TtsBackend]) -> TtsBackend:
    """앞에서부터 쓸 수 있는 첫 뒷단을 고른다. 마지막은 항상 SayBackend 여야 한다."""
    for backend in candidates:
        if backend.is_available():
            return backend
    raise RuntimeError("쓸 수 있는 TTS 뒷단이 없습니다 — say 조차 없는 환경입니다")


def default_tts() -> TtsBackend:
    return select_tts([SupertonicBackend(), SayBackend()])


# ---------------------------------------------------------------------------
# 귀 (STT)
# ---------------------------------------------------------------------------


@dataclass
class Transcription:
    text: str
    #: Whisper 가 내는 신호들. 환각 판정에 쓴다 (8.5절 ④).
    no_speech_prob: float | None
    avg_logprob: float | None
    compression_ratio: float | None
    latency_ms: int


class SttBackend(ABC):
    name: str = "abstract"

    @abstractmethod
    def is_available(self) -> bool: ...

    @abstractmethod
    def load(self, model: str) -> int:
        """모델을 올리고 걸린 시간(ms)을 돌려준다."""

    @abstractmethod
    def unload(self) -> None: ...

    @abstractmethod
    def transcribe(
        self, audio: np.ndarray, *, language: str, hints: str | None
    ) -> Transcription:
        """audio 는 16kHz float32 모노 (-1.0~1.0)."""


class MlxWhisperBackend(SttBackend):
    """Apple Silicon Metal 가속. 맥에서 기본값.

    실측 (M2 Air, 24초 한국어 샘플, 용어 힌트 있음)
      medium          RTF 0.122 · CER 0.8%   ← 채택
      large-v3-turbo  RTF 0.080 · CER 2.5%
      small           RTF 0.043 · CER 2.5%
      large-v3        RTF 1.812 — 실격. 발화보다 인식이 오래 걸린다.

    힌트 주입 효과가 극적이다: medium 은 힌트 없이 CER 38.8%, 있으면 0.8%.
    옵션이 아니라 필수다 (5.2절).
    """

    name = "mlx-whisper"

    #: 모델 이름 → mlx-community 저장소.
    REPOS = {
        "small": "mlx-community/whisper-small-mlx",
        "medium": "mlx-community/whisper-medium-mlx",
        "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
        "large-v3": "mlx-community/whisper-large-v3-mlx",
    }

    def __init__(self) -> None:
        self._repo: str | None = None

    def is_available(self) -> bool:
        try:
            import mlx_whisper  # noqa: F401
        except ImportError:
            return False
        return True

    def load(self, model: str) -> int:
        """mlx_whisper 는 명시적 로드가 없다 — 첫 추론에 올라온다.

        여기서는 저장소만 확정하고, 짧은 무음으로 한 번 돌려 예열한다.
        예열하지 않으면 첫 발화에서만 몇 초가 더 걸린다.
        """
        import mlx_whisper

        repo = self.REPOS.get(model)
        if repo is None:
            raise ValueError(f"알 수 없는 Whisper 모델: {model}")

        t0 = time.perf_counter()
        self._repo = repo
        mlx_whisper.transcribe(
            np.zeros(16_000, dtype=np.float32), path_or_hf_repo=repo, language="ko"
        )
        return int((time.perf_counter() - t0) * 1000)

    def unload(self) -> None:
        # mlx 는 가중치를 통합 메모리에 매핑해 둔다. 참조를 놓고 GC 를 돌린다.
        self._repo = None
        import gc

        gc.collect()

    def transcribe(
        self, audio: np.ndarray, *, language: str, hints: str | None
    ) -> Transcription:
        import mlx_whisper

        if self._repo is None:
            raise RuntimeError("모델이 로드되지 않았습니다")

        t0 = time.perf_counter()
        out = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self._repo,
            language=language,
            initial_prompt=hints or None,
            # 앞 구간의 결과를 다음 구간의 문맥으로 넣지 않는다.
            # 실측: 정확도는 그대로(CER 0.8%)이고 지연이 절반으로 줄었다
            # (7075ms → 3547ms). 환각 반복 고리도 끊긴다.
            #
            # 내장 억제 파라미터는 쓰지 않는다. hallucination_silence_threshold
            # 는 3.5배 느려지면서 환각을 막지 못했다 (실측). 환각 방어는
            # "무음을 인식기에 넘기지 않는 것"(hallucination.prejudge)뿐이다.
            condition_on_previous_text=False,
        )
        latency = int((time.perf_counter() - t0) * 1000)

        # 신호는 세그먼트별로 나온다. 가장 나쁜 값을 대표로 쓴다 —
        # 한 구간이라도 수상하면 의심하는 것이 안전하다.
        segments = out.get("segments") or []

        def worst(key: str, pick):
            values = [s[key] for s in segments if s.get(key) is not None]
            return pick(values) if values else None

        return Transcription(
            text=(out.get("text") or "").strip(),
            no_speech_prob=worst("no_speech_prob", max),
            avg_logprob=worst("avg_logprob", min),
            compression_ratio=worst("compression_ratio", max),
            latency_ms=latency,
        )


def default_stt() -> SttBackend:
    backend = MlxWhisperBackend()
    if not backend.is_available():
        raise RuntimeError(
            "mlx-whisper 를 찾을 수 없습니다. Apple Silicon 이 아니면 "
            "faster-whisper 뒷단이 필요합니다 (미구현)."
        )
    return backend
