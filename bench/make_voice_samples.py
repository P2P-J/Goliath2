#!/usr/bin/env python3
"""보이스 청취 샘플 생성 (개정 2판 개발 단계 0).

수퍼토닉 기본 보이스에 캐릭터 프리셋을 얹어 비교 청취용 파일을 만든다.
결과는 samples/voices/ 에 쌓이고 samples/목소리비교.html 로 듣는다.

두 손잡이는 서로 다르다 — 헷갈리기 쉬우므로 이름을 분리해 둔다.
  speed        말 속도. 1.05 가 수퍼토닉 기본값. 대화용은 1.3~1.5 가 편하다.
  pitch_factor 음높이 하강. 1.0 이 원본. 수퍼토닉에 음높이 파라미터가 없어
               합성 단계에서 speed 를 곱해 두고 후처리로 되돌린다.

  engine/.venv/bin/python bench/make_voice_samples.py
  engine/.venv/bin/python bench/make_voice_samples.py --speed 1.45
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engine"))

from goliath_engine.audio_fx import FxConfig, VoicePreset, apply_preset  # noqa: E402
from supertonic import TTS  # noqa: E402

LINES = [
    "골리앗 온라인. 명령을 기다리고 있습니다.",
    "말씀하신 파일을 준비해 두었습니다. 확인해 보시겠습니까?",
]
MALE = ["M1", "M2", "M3", "M4", "M5"]
FEMALE = ["F1", "F2", "F3", "F4", "F5"]

# 프리셋별 기본 음높이. 골리앗은 낮게, 자비스는 살짝만.
PITCH = {VoicePreset.GOLIATH: 1.14, VoicePreset.JARVIS: 1.07, VoicePreset.NONE: 1.0}


def render(
    tts: TTS, voice: str, preset: VoicePreset, *, speed: float, steps: int, pitch: float
) -> np.ndarray:
    """LINES 를 이어 붙인 한 개의 파형을 만든다."""
    style = tts.get_voice_style(voice)
    gap = np.zeros(int(tts.sample_rate * 0.55), dtype=np.float32)
    fx = FxConfig(preset=preset, pitch_factor=pitch)

    parts: list[np.ndarray] = []
    for line in LINES:
        # 후처리에서 pitch 배 늘어나므로, 합성 단계에서 미리 그만큼 빠르게 만든다.
        wav, _ = tts.synthesize(
            line, voice_style=style, lang="ko", total_steps=steps, speed=speed * pitch
        )
        parts.append(apply_preset(np.asarray(wav).reshape(-1), tts.sample_rate, fx))
        parts.append(gap)
    return np.concatenate(parts[:-1])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--speed", type=float, default=1.35, help="말 속도 (기본값 1.05)")
    ap.add_argument("--steps", type=int, default=8, help="품질 스텝 5~12")
    args = ap.parse_args()

    out = Path(__file__).resolve().parent.parent / "samples" / "voices"
    out.mkdir(parents=True, exist_ok=True)
    tts = TTS()
    sr = tts.sample_rate

    def write(name: str, audio: np.ndarray) -> None:
        sf.write(out / f"{name}.wav", audio, sr)
        print(f"  {name:<18} {len(audio)/sr:>5.1f}s")

    print(f"프리셋 비교 (속도 {args.speed}, 스텝 {args.steps})")
    for preset in (VoicePreset.GOLIATH, VoicePreset.JARVIS):
        for voice in MALE:
            audio = render(
                tts, voice, preset, speed=args.speed, steps=args.steps, pitch=PITCH[preset]
            )
            write(f"{voice}-{preset.value}", audio)

    print("\n속도 비교 (M3 · 골리앗)")
    for spd in (1.15, 1.35, 1.45):
        audio = render(
            tts, "M3", VoicePreset.GOLIATH, speed=spd, steps=args.steps,
            pitch=PITCH[VoicePreset.GOLIATH],
        )
        write(f"speed-{spd}", audio)

    print("\n원본 (효과 없음, 기본 속도)")
    for voice in MALE + FEMALE:
        audio = render(tts, voice, VoicePreset.NONE, speed=1.05, steps=args.steps, pitch=1.0)
        write(voice, audio)

    print(f"\n생성 위치: {out}\n비교 청취: open samples/목소리비교.html")


if __name__ == "__main__":
    main()
