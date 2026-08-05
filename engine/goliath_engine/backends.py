"""귀(STT)와 입(TTS)의 교체 가능한 뒷단.

기획서 10절 원칙 3: "음성 엔진은 교체 가능한 부품이다."
protocol.py 가 프로세스 경계의 계약이고, 이 파일이 그 안쪽의 계약이다.
Fish Audio 를 다른 TTS 로 바꿔도 __main__.py 는 손대지 않는다.

TTS 뒷단이 셋인 이유:
  FishCloudBackend : 어디서나 돈다. 8 GB 맥북 포함. M1 의 기본값.
  FishLocalBackend : S2-Pro 4B 오픈 웨이트. GPU 있는 기계에서만 현실적이다
                     (공식 추론 스택이 SGLang/CUDA 지향이고 Apple Silicon 지원이 문서에 없다).
  SayBackend       : macOS 내장 음성. 위 둘이 실패하면 자동 전환 (5.1절 폴백).

STT 뒷단이 둘인 이유:
  MlxWhisperBackend     : Apple Silicon 에서 Metal 가속. 맥에서 가장 빠르다.
  FasterWhisperBackend  : CTranslate2. CPU/CUDA 양쪽. 데스크톱·리눅스용.
"""

from __future__ import annotations

import shutil
import subprocess
from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass


# ---------------------------------------------------------------------------
# 입 (TTS)
# ---------------------------------------------------------------------------


@dataclass
class SpeechRequest:
    text: str
    voice_id: str | None = None
    rate: float = 1.0
    pitch: float = 0.0


class TtsBackend(ABC):
    """텍스트를 소리로. 오디오는 이 프로세스 밖으로 나가지 않는다 (원칙 1)."""

    name: str = "abstract"

    @abstractmethod
    def is_available(self) -> bool:
        """지금 이 기계에서 쓸 수 있는지. 키가 없거나 GPU 가 없으면 False."""

    @abstractmethod
    def synthesize(self, request: SpeechRequest) -> Iterator[bytes]:
        """오디오 청크를 순서대로 내놓는다.

        문장 단위 스트리밍이 핵심이다 — 첫 청크를 빨리 내야 발화종료→첫소리
        지연이 6초 안에 들어온다 (M1 통과 조건, 리스크 #1 대응).
        """

    def cancel(self) -> None:
        """진행 중인 합성을 중단한다. 끼어들기(2.3절)가 여기에 달려 있다."""


class FishCloudBackend(TtsBackend):
    """Fish Audio 클라우드 API. 기본 경로."""

    name = "fish-cloud"

    def __init__(self, api_key: str | None) -> None:
        self.api_key = api_key

    def is_available(self) -> bool:
        return bool(self.api_key)

    def synthesize(self, request: SpeechRequest) -> Iterator[bytes]:
        # TODO(M1): Fish Audio TTS 엔드포인트로 스트리밍 요청.
        #   - 문장 단위로 쪼개 보내 첫 소리를 앞당긴다.
        #   - 네트워크 실패는 예외로 올려서 SayBackend 로 폴백시킨다 (8.4절).
        raise NotImplementedError("M1")


class FishLocalBackend(TtsBackend):
    """Fish Audio S2-Pro 로컬 가중치. GPU 있는 기계용."""

    name = "fish-local"

    def __init__(self, model_path: str | None) -> None:
        self.model_path = model_path

    def is_available(self) -> bool:
        if not self.model_path:
            return False
        # TODO(M5): CUDA 가용성 확인. Apple Silicon 에서는 현재 경로가 없다.
        return False

    def synthesize(self, request: SpeechRequest) -> Iterator[bytes]:
        raise NotImplementedError("M5")


class SayBackend(TtsBackend):
    """macOS 내장 음성. 폴백 전용 — 항상 되는 것이 존재 이유다 (5.1절)."""

    name = "macos-say"

    def __init__(self, voice: str = "Yuna") -> None:  # Yuna: 한국어 음성
        self.voice = voice
        self._proc: subprocess.Popen[bytes] | None = None

    def is_available(self) -> bool:
        return shutil.which("say") is not None

    def synthesize(self, request: SpeechRequest) -> Iterator[bytes]:
        # say 는 스피커로 직접 재생하므로 청크를 돌려줄 것이 없다.
        # 폴백 경로에서는 "소리가 난다"가 유일한 요구사항이다.
        self._proc = subprocess.Popen(
            ["say", "-v", self.voice, "-r", str(int(180 * request.rate)), request.text]
        )
        self._proc.wait()
        return iter(())

    def cancel(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()


def select_tts(candidates: list[TtsBackend]) -> TtsBackend:
    """앞에서부터 쓸 수 있는 첫 뒷단을 고른다. 마지막은 항상 SayBackend 여야 한다."""
    for backend in candidates:
        if backend.is_available():
            return backend
    raise RuntimeError("쓸 수 있는 TTS 뒷단이 없습니다 — say 조차 없는 환경입니다")


# ---------------------------------------------------------------------------
# 귀 (STT)
# ---------------------------------------------------------------------------


@dataclass
class Transcription:
    text: str
    confidence: float
    latency_ms: int


class SttBackend(ABC):
    name: str = "abstract"

    @abstractmethod
    def load(self, model: str) -> int:
        """모델을 메모리에 올리고 걸린 시간(ms)을 돌려준다 (7.1절 생명주기)."""

    @abstractmethod
    def unload(self) -> None:
        """모델을 즉시 해제한다. 유휴 15분·인식 비활성화에서 호출된다."""

    @abstractmethod
    def transcribe(self, audio: bytes, *, language: str, hints: list[str]) -> Transcription:
        """hints 는 5.2절 개발 용어 힌트(initial prompt)로 넘긴다."""


class MlxWhisperBackend(SttBackend):
    """Apple Silicon Metal 가속. 맥에서 기본값."""

    name = "mlx-whisper"

    def load(self, model: str) -> int:
        raise NotImplementedError("M1")

    def unload(self) -> None:
        raise NotImplementedError("M1")

    def transcribe(self, audio: bytes, *, language: str, hints: list[str]) -> Transcription:
        raise NotImplementedError("M1")


class FasterWhisperBackend(SttBackend):
    """CTranslate2. CPU/CUDA. 데스크톱·리눅스에서 기본값."""

    name = "faster-whisper"

    def load(self, model: str) -> int:
        raise NotImplementedError("M1")

    def unload(self) -> None:
        raise NotImplementedError("M1")

    def transcribe(self, audio: bytes, *, language: str, hints: list[str]) -> Transcription:
        raise NotImplementedError("M1")
