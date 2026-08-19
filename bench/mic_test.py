#!/usr/bin/env python3
"""실제 마이크로 귀를 검증한다 (M2).

합성 음성으로는 확인할 수 없는 것들을 본다 — 실제 마이크의 잡음, 사용자의
발화 습관, 1.2초 침묵으로 잘 끊기는지, 웨이크워드가 오탐하지 않는지.

  engine/.venv/bin/python bench/mic_test.py            # 계속 듣기
  engine/.venv/bin/python bench/mic_test.py --wake     # 웨이크워드로 깨우기
  engine/.venv/bin/python bench/mic_test.py --model large-v3-turbo

Ctrl-C 로 끝낸다.
"""

from __future__ import annotations

import argparse
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engine"))

import numpy as np  # noqa: E402

from goliath_engine.backends import default_stt  # noqa: E402
from goliath_engine.hallucination import Verdict, judge  # noqa: E402
from goliath_engine.microphone import Microphone, UtteranceCollector  # noqa: E402

HINTS = (
    "타입스크립트, 리팩터링, useEffect, 일렉트론, 렌더러, 프로토콜, "
    "웨이크워드, 커밋, 빌드, 디플로이, 비동기, 골리앗"
)

MARK = {Verdict.ACCEPT: "✅", Verdict.DISCARD: "🗑", Verdict.ASK_AGAIN: "❓"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="medium", help="small | medium | large-v3-turbo")
    ap.add_argument("--wake", action="store_true", help="웨이크워드로 깨우기")
    ap.add_argument("--wake-model", default="hey_jarvis")
    ap.add_argument("--threshold", type=float, default=0.5)
    args = ap.parse_args()

    print(f"Whisper {args.model} 예열 중…", flush=True)
    stt = default_stt()
    load_ms = stt.load(args.model)
    print(f"  준비 완료 ({load_ms} ms)\n")

    wake_model = None
    if args.wake:
        from openwakeword.model import Model

        wake_model = Model(
            wakeword_models=[args.wake_model], inference_framework="onnx"
        )
        print(f'웨이크워드: {args.wake_model} — "헤이 자비스" 라고 말해보세요\n')

    collector = UtteranceCollector()
    mic = Microphone(on_error=lambda m: print(f"  ⚠ {m}"))

    state = {"wake_at": 0.0, "level": 0.0}

    def on_frame(frame: np.ndarray) -> None:
        state["level"] = max(state["level"], float(np.abs(frame).max()) / 32768.0)
        collector.feed(frame)
        if wake_model is None or collector.is_active:
            return
        now = time.monotonic()
        if now - state["wake_at"] < 2.0:
            return
        score = float(wake_model.predict(frame).get(args.wake_model, 0.0))
        if score >= args.threshold:
            state["wake_at"] = now
            print(f"\n🔔 웨이크워드 감지 ({score:.2f})")
            collector.begin(preroll=mic.preroll())

    mic.subscribe(on_frame)
    mic.start()

    if not args.wake:
        print("말해보세요. 1.2초 조용해지면 인식합니다.  (Ctrl-C 로 종료)\n")

    turn = 0
    try:
        while True:
            if not collector.is_active:
                if args.wake:
                    time.sleep(0.05)
                    continue
                collector.begin(preroll=mic.preroll())

            utterance = collector.wait(timeout=60.0)
            if utterance is None:
                continue

            turn += 1
            t0 = time.perf_counter()
            result = stt.transcribe(
                utterance.audio, language="ko", hints=HINTS
            )
            total = int((time.perf_counter() - t0) * 1000)

            verdict = judge(
                result.text,
                duration_sec=utterance.duration_sec,
                speech_ratio=utterance.speech_ratio,
                no_speech_prob=result.no_speech_prob,
                avg_logprob=result.avg_logprob,
                compression_ratio=result.compression_ratio,
            )

            conf = result.avg_logprob
            print(f"{MARK[verdict.verdict]} [{turn}] {result.text or '(빈 결과)'}")
            print(
                f"     수집 {utterance.duration_sec:.1f}s · 발화 "
                f"{utterance.speech_sec:.1f}s ({utterance.speech_ratio:.0%})"
                f" · 인식 {total}ms · 신뢰도 "
                + (f"{conf:.2f}" if conf is not None and math.isfinite(conf) else "—")
                + (f" · 폐기 {verdict.reason}" if verdict.reason else "")
            )

            level = state["level"]
            notes = []
            if utterance.clipped_ratio > 0.02:
                notes.append(
                    f"⚠ 포화 {utterance.clipped_ratio:.0%} — 시스템 설정 > 사운드 >"
                    " 입력에서 마이크 볼륨을 낮추세요. 포화된 소리는 VAD 를 속입니다"
                )
            elif level > 0.95:
                notes.append("⚠ 입력이 매우 큽니다 — 마이크 볼륨을 낮춰보세요")
            elif level < 0.02:
                notes.append("⚠ 입력이 너무 작습니다 — 마이크를 확인하세요")
            print(f"     최대 레벨 {level:.2f}")
            for note in notes:
                print(f"     {note}")
            state["level"] = 0.0
            print()

    except KeyboardInterrupt:
        print("\n종료")
    finally:
        mic.stop()


if __name__ == "__main__":
    main()
