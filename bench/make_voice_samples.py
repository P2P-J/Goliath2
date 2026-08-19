#!/usr/bin/env python3
"""보이스 청취용 샘플 생성 (개정 2판 개발 단계 0).

수퍼토닉 기본 보이스 10종으로 같은 한국어 대사를 합성해
samples/voices/ 에 넣고, samples/목소리비교.html 로 비교 청취한다.

수퍼토닉에는 음높이 파라미터가 없으므로, 저음이 필요하면
--deep 으로 튜닝판을 함께 만든다. 원리는 빠르게 합성한 뒤
느리게 재생하는 것 — 길이는 그대로 두고 음높이만 내린다.

  engine/.venv/bin/python bench/make_voice_samples.py
  engine/.venv/bin/python bench/make_voice_samples.py --factor 1.25   # 더 낮게
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import soundfile as sf
from supertonic import TTS

LINES = [
    "골리앗 온라인. 명령을 기다리고 있습니다.",
    "말씀하신 파일을 준비해 두었습니다. 확인해 보시겠습니까?",
]
MALE = ["M1", "M2", "M3", "M4", "M5"]
FEMALE = ["F1", "F2", "F3", "F4", "F5"]


def pitch_down(x: np.ndarray, factor: float) -> np.ndarray:
    """factor 배 빠르게 합성한 파형을 늘여 재생 → 길이 복원, 음높이 하강."""
    n = int(len(x) * factor)
    return np.interp(
        np.linspace(0, len(x) - 1, n), np.arange(len(x)), x
    ).astype(np.float32)


def render(tts: TTS, voice: str, *, steps: int, factor: float | None) -> np.ndarray:
    style = tts.get_voice_style(voice)
    gap = np.zeros(int(tts.sample_rate * 0.6), dtype=np.float32)
    speed = 1.05 * factor if factor else 1.05

    parts: list[np.ndarray] = []
    for line in LINES:
        wav, _ = tts.synthesize(
            line, voice_style=style, lang="ko", total_steps=steps, speed=speed
        )
        mono = np.asarray(wav).reshape(-1).astype(np.float32)
        parts.append(pitch_down(mono, factor) if factor else mono)
        parts.append(gap)
    return np.concatenate(parts[:-1])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=8, help="품질 스텝 5~12")
    ap.add_argument("--factor", type=float, default=1.14, help="저음 튜닝 배율 (1.0=원본)")
    ap.add_argument("--no-deep", action="store_true", help="저음 튜닝판 생략")
    args = ap.parse_args()

    out = Path(__file__).resolve().parent.parent / "samples" / "voices"
    out.mkdir(parents=True, exist_ok=True)

    tts = TTS()
    sr = tts.sample_rate

    for voice in MALE + FEMALE:
        audio = render(tts, voice, steps=args.steps, factor=None)
        sf.write(out / f"{voice}.wav", audio, sr)
        print(f"{voice:<9} {len(audio)/sr:.1f}s")

    if not args.no_deep:
        for voice in MALE:
            audio = render(tts, voice, steps=args.steps, factor=args.factor)
            sf.write(out / f"{voice}-deep.wav", audio, sr)
            print(f"{voice + '-deep':<9} {len(audio)/sr:.1f}s  (×{args.factor})")

    print(f"\n생성 위치: {out}")
    print("비교 청취: open samples/목소리비교.html")


if __name__ == "__main__":
    main()
