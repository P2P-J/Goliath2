#!/usr/bin/env python3
"""M0 — Whisper 모델별 메모리·지연 실측.

기획서 7.3절: "측정 없는 최적화는 하지 않는다. 계측을 먼저 붙이고 실측 후
병목만 손댄다." 7.2절 표의 수치는 추정치이므로, 실제로 돌릴 기계에서 재서
기본 모델을 고른다.

재는 것
  - 모델 로드 시간과 로드 후 RSS 증가량
  - 발화 길이 대비 인식 시간 (RTF)
  - 반복 추론 중 RSS 증가 (누수 확인 — M6 통과 조건과 직결)

쓰는 법
  # 맥 (Apple Silicon, Metal 가속)
  pip install mlx-whisper psutil
  python bench/whisper_bench.py samples/ko_30s.wav --backend mlx

  # 데스크톱/리눅스 (CPU 또는 CUDA)
  pip install faster-whisper psutil
  python bench/whisper_bench.py samples/ko_30s.wav --backend faster

결과는 bench/results/ 에 JSON 으로 쌓인다. 기계마다 다르므로 저장소에 넣지 않는다.
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import platform
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import psutil
except ImportError:  # pragma: no cover
    raise SystemExit("psutil 이 필요합니다: pip install psutil")


DEFAULT_MODELS = ["large-v3", "large-v3-turbo", "medium", "small"]

# 5.2절 개발 용어 힌트. 인식률 비교를 위해 힌트 유/무 양쪽을 잰다.
HINTS = (
    "useEffect, 타입스크립트, 리팩터링, 커밋, 머지, 디플로이, "
    "일렉트론, 렌더러, 프로토콜, 웨이크워드"
)


def rss_mb() -> float:
    return psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)


def swap_pages() -> int:
    """스왑아웃 누적 페이지 수. 팬리스 맥에서 이 값이 늘면 실격이다."""
    try:
        return psutil.swap_memory().sout
    except Exception:
        return 0


def audio_seconds(path: Path) -> float:
    """wave 로 길이를 읽는다. wav 가 아니면 0 을 돌려주고 RTF 계산을 건너뛴다."""
    import wave

    try:
        with wave.open(str(path), "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 0.0


def bench_mlx(model: str, audio: Path, runs: int, hints: str | None) -> dict:
    import mlx_whisper

    repo = f"mlx-community/whisper-{model}-mlx"
    baseline = rss_mb()

    t0 = time.perf_counter()
    # mlx_whisper 는 명시적 load 가 없다 — 첫 호출에 로드된다.
    first = mlx_whisper.transcribe(
        str(audio), path_or_hf_repo=repo, language="ko", initial_prompt=hints
    )
    load_and_first_ms = int((time.perf_counter() - t0) * 1000)
    loaded_rss = rss_mb()

    latencies = []
    for _ in range(runs):
        t = time.perf_counter()
        mlx_whisper.transcribe(
            str(audio), path_or_hf_repo=repo, language="ko", initial_prompt=hints
        )
        latencies.append(int((time.perf_counter() - t) * 1000))

    return {
        "loadAndFirstMs": load_and_first_ms,
        "rssAfterLoadMb": round(loaded_rss - baseline, 1),
        "rssPeakMb": round(rss_mb() - baseline, 1),
        "latenciesMs": latencies,
        "text": first.get("text", "").strip()[:200],
    }


def bench_faster(model: str, audio: Path, runs: int, hints: str | None) -> dict:
    from faster_whisper import WhisperModel

    baseline = rss_mb()

    t0 = time.perf_counter()
    engine = WhisperModel(model, device="auto", compute_type="int8")
    load_ms = int((time.perf_counter() - t0) * 1000)
    loaded_rss = rss_mb()

    def once() -> str:
        segments, _info = engine.transcribe(
            str(audio), language="ko", initial_prompt=hints, vad_filter=True
        )
        return "".join(seg.text for seg in segments)  # generator — 소진해야 실행된다

    t = time.perf_counter()
    text = once()
    first_ms = int((time.perf_counter() - t) * 1000)

    latencies = [first_ms]
    for _ in range(runs - 1):
        t = time.perf_counter()
        once()
        latencies.append(int((time.perf_counter() - t) * 1000))

    del engine
    gc.collect()

    return {
        "loadMs": load_ms,
        "loadAndFirstMs": load_ms + first_ms,
        "rssAfterLoadMb": round(loaded_rss - baseline, 1),
        "rssPeakMb": round(rss_mb() - baseline, 1),
        "latenciesMs": latencies,
        "text": text.strip()[:200],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", type=Path, help="한국어 샘플 (wav 권장, 20~40초)")
    ap.add_argument("--backend", choices=["mlx", "faster"], required=True)
    ap.add_argument("--models", nargs="*", default=DEFAULT_MODELS)
    ap.add_argument("--runs", type=int, default=5, help="모델당 반복 추론 횟수")
    ap.add_argument("--no-hints", action="store_true", help="용어 힌트 없이 측정")
    args = ap.parse_args()

    if not args.audio.exists():
        raise SystemExit(f"샘플이 없습니다: {args.audio}")

    hints = None if args.no_hints else HINTS
    duration = audio_seconds(args.audio)
    runner = bench_mlx if args.backend == "mlx" else bench_faster

    report = {
        "when": datetime.now(timezone.utc).isoformat(),
        "machine": {
            "platform": platform.platform(),
            "processor": platform.processor() or platform.machine(),
            "totalMemoryGb": round(psutil.virtual_memory().total / 1024**3, 1),
        },
        "backend": args.backend,
        "audio": {"path": str(args.audio), "seconds": round(duration, 2)},
        "hints": bool(hints),
        "results": {},
    }

    print(f"기계: {report['machine']['processor']} / {report['machine']['totalMemoryGb']} GB")
    print(f"샘플: {args.audio.name} ({duration:.1f}초) / 힌트: {'있음' if hints else '없음'}\n")

    for model in args.models:
        swap_before = swap_pages()
        print(f"[{model}] 측정 중…", flush=True)
        try:
            result = runner(model, args.audio, args.runs, hints)
        except Exception as exc:
            print(f"  실패: {exc}\n")
            report["results"][model] = {"error": str(exc)}
            continue

        lat = result["latenciesMs"]
        median = statistics.median(lat)
        result["medianMs"] = median
        result["rtf"] = round(median / 1000 / duration, 3) if duration else None
        result["swapPagesDelta"] = swap_pages() - swap_before
        report["results"][model] = result

        print(f"  로드+첫추론 : {result['loadAndFirstMs']} ms")
        print(f"  RSS 증가    : {result['rssAfterLoadMb']} MB (피크 {result['rssPeakMb']} MB)")
        print(f"  지연 중앙값 : {median} ms" + (f"  (RTF {result['rtf']})" if duration else ""))
        print(f"  스왑아웃 증가: {result['swapPagesDelta']} 페이지")
        print(f"  인식 결과   : {result['text'][:80]}\n")

        gc.collect()

    out_dir = Path(__file__).parent / "results"
    out_dir.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = out_dir / f"whisper-{args.backend}-{stamp}.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"기록: {out_path}")

    print("\n판정 기준 (M0)")
    print("  - 스왑아웃 증가 > 0        → 실격 (팬리스에서 지연 폭발)")
    print("  - 발화종료→첫소리 6초 초과 → 실격 (M1 통과 조건)")
    print("  → 통과하는 가장 큰 모델을 기본값으로 채택한다")


if __name__ == "__main__":
    main()
