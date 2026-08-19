#!/usr/bin/env python3
"""수퍼토닉 한국어 합성 실측.

기획서 5장의 성능 주장을 실제로 돌릴 기계에서 확인한다.
"M1 맥에서 초당 1000자 이상"은 벤더 수치이므로, 여기서 재는 것은
"이 기계에서 대화가 성립하는가"이다.

판정 기준
  RTF < 1.0        재생보다 빠르게 만들어야 끊기지 않는다
  첫 문장 < 1.5초  문장 단위 스트리밍이면 이게 곧 첫 소리까지의 지연이다

쓰는 법
  engine/.venv/bin/python bench/supertonic_bench.py
  engine/.venv/bin/python bench/supertonic_bench.py --voice F2 --steps 12
"""

from __future__ import annotations

import argparse
import json
import platform
import resource
import statistics
import time
from datetime import datetime
from pathlib import Path

from supertonic import TTS

CASES = [
    ("짧은 응답", "네, 알겠습니다."),
    ("한 문장", "말씀하신 파일을 문서 폴더에 준비해 두었습니다."),
    ("보통 답변", "세 군데를 수정했습니다. 인증 로직의 순서를 바꾸고, 예외 처리를 추가했으며, 테스트를 보강했습니다."),
    (
        "긴 답변",
        "요청하신 내용을 정리했습니다. 먼저 프로젝트 구조를 살펴본 결과 메인 프로세스와 렌더러 "
        "사이의 통신이 병목이었습니다. 이를 해결하기 위해 메시지 전달 방식을 비동기로 바꾸고, "
        "불필요한 직렬화를 제거했습니다. 그 결과 응답 지연이 절반 이하로 줄었습니다.",
    ),
]


def rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="M3", help="F1~F5, M1~M5")
    ap.add_argument("--steps", type=int, default=8, help="품질 스텝 5~12")
    ap.add_argument("--runs", type=int, default=3)
    args = ap.parse_args()

    t0 = time.perf_counter()
    tts = TTS()
    load_ms = (time.perf_counter() - t0) * 1000
    style = tts.get_voice_style(args.voice)
    sr = tts.sample_rate

    print(f"기계   : {platform.processor() or platform.machine()} / {platform.platform()}")
    print(f"보이스 : {args.voice} · 스텝 {args.steps} · {sr} Hz")
    print(f"로드   : {load_ms:.0f} ms · RSS {rss_mb():.0f} MB\n")

    report = {
        "when": datetime.now().isoformat(),
        "machine": platform.platform(),
        "voice": args.voice,
        "steps": args.steps,
        "loadMs": round(load_ms),
        "cases": {},
    }

    print(f"{'구분':<9}{'글자':>4}{'합성ms':>8}{'오디오s':>8}{'RTF':>7}")
    print("-" * 39)
    for label, text in CASES:
        runs = []
        wav = None
        for _ in range(args.runs):
            t = time.perf_counter()
            wav, _ = tts.synthesize(
                text, voice_style=style, lang="ko", total_steps=args.steps
            )
            runs.append((time.perf_counter() - t) * 1000)
        ms = statistics.median(runs)
        dur = wav.shape[-1] / sr
        rtf = ms / 1000 / dur
        report["cases"][label] = {
            "chars": len(text),
            "synthMs": round(ms),
            "audioSec": round(dur, 2),
            "rtf": round(rtf, 3),
        }
        print(f"{label:<9}{len(text):>4}{ms:>8.0f}{dur:>8.2f}{rtf:>7.3f}")

    report["peakRssMb"] = round(rss_mb())
    print(f"\n피크 RSS: {report['peakRssMb']} MB")

    worst = max(c["rtf"] for c in report["cases"].values())
    first = report["cases"]["한 문장"]["synthMs"]
    print(f"\n판정  RTF 최대 {worst:.3f} → {'통과' if worst < 1.0 else '실격'}")
    print(f"      첫 문장 {first} ms → {'통과' if first < 1500 else '재검토'}")

    out = Path(__file__).parent / "results"
    out.mkdir(exist_ok=True)
    path = out / f"supertonic-{args.voice}-{datetime.now():%Y%m%d-%H%M%S}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n기록: {path}")


if __name__ == "__main__":
    main()
