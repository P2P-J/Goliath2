"""음성 출력 후처리 — 캐릭터 프리셋.

수퍼토닉은 담백한 목소리를 내준다. 골리앗이라는 이름이 가리키는 캐릭터
(스타크래프트 골리앗의 기동 대사, 자비스의 다듬어진 집사 톤)는 모델이
아니라 여기서 만든다.

의존성은 numpy 하나뿐이다. 필터는 전부 FFT 기반 영위상(zero-phase)이라
위상 왜곡이 없고, 오프라인 처리이므로 IIR 을 흉내 낼 이유가 없다.

프리셋
  NONE     : 원본 그대로
  JARVIS   : 저역 정리 + 프레즌스 부스트 + 짧은 잔향. 깨끗하고 다듬어진 느낌.
  GOLIATH  : 무전기 대역 제한 + 새추레이션 + 링 변조 + 슬랩백. 기계·통신 느낌.

두 프리셋 모두 마지막에 완만한 컴프레션과 정규화를 건다 —
말할 때마다 음량이 들쭉날쭉하면 비서로서 피곤하다.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import numpy as np


class VoicePreset(str, Enum):
    NONE = "none"
    JARVIS = "jarvis"
    GOLIATH = "goliath"


@dataclass
class FxConfig:
    """설정 UI 가 노출할 값들 (기획서 3장 '속도·톤 커스텀')."""

    preset: VoicePreset = VoicePreset.NONE
    #: 음높이 하강 배율. 1.0 = 원본. 수퍼토닉에 음높이 파라미터가 없어 후처리로 낸다.
    pitch_factor: float = 1.0
    #: 효과 강도. 0.0 = 무효과, 1.0 = 프리셋 기본값.
    intensity: float = 1.0


# ---------------------------------------------------------------------------
# 기초 블록
# ---------------------------------------------------------------------------


def _spectrum(x: np.ndarray, sr: int):
    n_fft = 1 << max(1, len(x) - 1).bit_length()
    return np.fft.rfft(x, n_fft), np.fft.rfftfreq(n_fft, 1.0 / sr), n_fft


def _apply_curve(x: np.ndarray, sr: int, curve: np.ndarray, n_fft: int) -> np.ndarray:
    spec = np.fft.rfft(x, n_fft) * curve
    return np.fft.irfft(spec, n_fft)[: len(x)].astype(np.float32)


def _butter_mag(freqs: np.ndarray, cutoff: float, order: int, high_pass: bool) -> np.ndarray:
    """버터워스 크기 응답. 위상은 건드리지 않는다."""
    f = np.maximum(freqs, 1e-6)
    ratio = (cutoff / f) if high_pass else (f / cutoff)
    return 1.0 / np.sqrt(1.0 + ratio ** (2 * order))


def _peak_mag(freqs: np.ndarray, center: float, gain_db: float, width_oct: float) -> np.ndarray:
    """옥타브 폭 기준 종형 EQ."""
    f = np.maximum(freqs, 1e-6)
    octaves = np.log2(f / center)
    bell = np.exp(-0.5 * (octaves / width_oct) ** 2)
    return 10 ** (gain_db * bell / 20.0)


def pitch_shift(x: np.ndarray, factor: float) -> np.ndarray:
    """factor 배 빠르게 합성된 파형을 늘여 음높이를 내린다.

    수퍼토닉에 음높이 파라미터가 없으므로, 합성 단계에서 speed 를 factor 만큼
    올리고 여기서 되돌린다. 길이는 원본과 같아지고 음높이만 내려간다.
    """
    if abs(factor - 1.0) < 1e-3:
        return x
    n = int(len(x) * factor)
    return np.interp(
        np.linspace(0, len(x) - 1, n), np.arange(len(x)), x
    ).astype(np.float32)


def _saturate(x: np.ndarray, drive: float) -> np.ndarray:
    """tanh 소프트 클리핑. 하드 클리핑과 달리 배음이 부드럽게 붙는다."""
    if drive <= 1.0:
        return x
    return (np.tanh(drive * x) / np.tanh(drive)).astype(np.float32)


def _delay_mix(x: np.ndarray, sr: int, ms: float, amount: float) -> np.ndarray:
    n = int(sr * ms / 1000.0)
    if n <= 0 or amount <= 0:
        return x
    out = x.copy()
    out[n:] += amount * x[:-n]
    return out


def _reverb(x: np.ndarray, sr: int, decay_ms: float, mix: float) -> np.ndarray:
    """감쇠 잡음을 임펄스로 쓰는 짧은 잔향. FFT 합성곱."""
    if mix <= 0:
        return x
    n = int(sr * decay_ms / 1000.0)
    rng = np.random.default_rng(7)  # 재현 가능해야 한다
    t = np.arange(n) / sr
    impulse = rng.standard_normal(n) * np.exp(-t / (decay_ms / 3000.0))
    impulse[0] = 1.0
    impulse /= np.abs(impulse).sum()

    size = 1 << (len(x) + n - 1).bit_length()
    wet = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(impulse, size), size)[: len(x)]
    return ((1 - mix) * x + mix * wet).astype(np.float32)


def _compress(x: np.ndarray, sr: int, threshold: float, ratio: float) -> np.ndarray:
    """포락선 기반 완만한 컴프레션. 음량 편차를 줄인다."""
    win = max(1, int(sr * 0.008))
    env = np.abs(x)
    kernel = np.ones(win) / win
    env = np.convolve(env, kernel, mode="same")

    gain = np.ones_like(env)
    over = env > threshold
    gain[over] = (threshold + (env[over] - threshold) / ratio) / np.maximum(env[over], 1e-9)
    # 게인이 급변하면 펌핑이 들린다 — 한 번 더 완만하게.
    gain = np.convolve(gain, kernel, mode="same")
    return (x * gain).astype(np.float32)


def _normalize(x: np.ndarray, peak: float = 0.92) -> np.ndarray:
    m = float(np.max(np.abs(x)))
    return (x * (peak / m)).astype(np.float32) if m > 1e-9 else x.astype(np.float32)


# ---------------------------------------------------------------------------
# 프리셋
# ---------------------------------------------------------------------------


def _jarvis(x: np.ndarray, sr: int, k: float) -> np.ndarray:
    """다듬어진 집사 톤. 과하게 걸지 않는 게 요령이다."""
    _, freqs, n_fft = _spectrum(x, sr)
    curve = (
        _butter_mag(freqs, 85, 2, high_pass=True)          # 럼블 제거
        * _peak_mag(freqs, 340, -2.5 * k, 0.9)             # 박스한 저중역 정리
        * _peak_mag(freqs, 3200, 3.5 * k, 1.1)             # 프레즌스 — 또렷함
        * _peak_mag(freqs, 9000, 1.5 * k, 1.0)             # 공기감
        * _butter_mag(freqs, 15000, 4, high_pass=False)
    )
    y = _apply_curve(x, sr, curve, n_fft)
    y = _reverb(y, sr, decay_ms=140, mix=0.10 * k)         # 작은 방
    y = _compress(y, sr, threshold=0.32, ratio=2.6)
    return _normalize(y)


def _goliath(x: np.ndarray, sr: int, k: float) -> np.ndarray:
    """무전기 너머의 기계. 대역을 좁히는 것이 정체성이다."""
    _, freqs, n_fft = _spectrum(x, sr)
    # 통신 대역(300~3400Hz)으로 좁힌다. k 로 좁힘 정도를 조절.
    lo = 300 - 210 * (1 - k)
    hi = 3400 + 12000 * (1 - k)
    curve = (
        _butter_mag(freqs, lo, 4, high_pass=True)
        * _butter_mag(freqs, hi, 4, high_pass=False)
        * _peak_mag(freqs, 1900, 4.0 * k, 0.8)             # 무전기 특유의 중역 강조
    )
    y = _apply_curve(x, sr, curve, n_fft)

    y = _saturate(y, drive=1.0 + 2.2 * k)                  # 회로 포화

    # 링 변조 — 금속성 배음. 깊게 걸면 로봇이 되므로 얕게.
    t = np.arange(len(y)) / sr
    depth = 0.10 * k
    y = y * (1.0 - depth + depth * np.sin(2 * np.pi * 58.0 * t)).astype(np.float32)

    y = _delay_mix(y, sr, ms=52, amount=0.16 * k)          # 슬랩백 — 통신 공간감

    if k > 0:                                               # 무전기 노이즈 플로어
        rng = np.random.default_rng(11)
        noise = rng.standard_normal(len(y)).astype(np.float32)
        _, nf, n2 = _spectrum(noise, sr)
        noise = _apply_curve(
            noise, sr,
            _butter_mag(nf, 500, 2, True) * _butter_mag(nf, 3000, 3, False), n2
        )
        y = y + noise * 0.0035 * k

    y = _compress(y, sr, threshold=0.26, ratio=3.5)
    return _normalize(y)


def apply_preset(x: np.ndarray, sr: int, config: FxConfig) -> np.ndarray:
    """합성된 파형에 캐릭터 프리셋을 적용한다."""
    y = np.asarray(x, dtype=np.float32).reshape(-1)
    y = pitch_shift(y, config.pitch_factor)

    k = float(np.clip(config.intensity, 0.0, 1.0))
    if config.preset is VoicePreset.JARVIS and k > 0:
        return _jarvis(y, sr, k)
    if config.preset is VoicePreset.GOLIATH and k > 0:
        return _goliath(y, sr, k)
    return _normalize(y)
