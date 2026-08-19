#!/usr/bin/env python3
"""M2 — Whisper 모델별 메모리·지연·정확도 실측.

기획서 10.3절: "측정 없는 최적화는 하지 않는다."
10.2절 표의 메모리 수치는 추정치이므로, 실제로 돌릴 기계에서 재서 기본 모델을 고른다.

판정 기준 (재기 전에 고정한다)
  스왑아웃 증가 > 0    → 실격. 팬리스 맥에서 스왑은 곧 지연 폭발이다.
  인식 지연 > 발화 길이 → 실격. 대화가 성립하지 않는다.
  → 통과하는 것 중 CER 이 가장 낮은 모델을 채택한다.

샘플은 수퍼토닉으로 만든 한국어 음성이라 정답 텍스트가 있다.
실제 마이크 입력보다 깨끗하므로 CER 은 낙관적으로 나온다 — 모델 간 비교용이다.

  engine/.venv/bin/python bench/whisper_bench.py
  engine/.venv/bin/python bench/whisper_bench.py --models small medium
"""

from __future__ import annotations

import argparse
import gc
import json
import platform
import re
import resource
import statistics
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent

#: mlx-community 저장소 이름. 없는 모델은 건너뛴다.
REPOS = {
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}

#: 5.2절 개발 용어 힌트. 힌트 유/무를 나눠 재서 효과를 확인한다.
HINTS = (
    "타입스크립트, 리팩터링, useEffect, 일렉트론, 렌더러, 프로토콜, "
    "웨이크워드, 커밋, 빌드, 디플로이, 비동기"
)


def rss_mb() -> float:
    """현재 RSS. ru_maxrss 는 생애 최대치라 모델을 연달아 재면 증가분이 0 이 된다."""
    import psutil

    return psutil.Process().memory_info().rss / (1024 * 1024)


def swap_out() -> int:
    """스왑아웃 누적. 이 값이 늘면 실격이다."""
    import subprocess

    try:
        out = subprocess.run(["vm_stat"], capture_output=True, text=True).stdout
        m = re.search(r"Pageouts:\s+(\d+)", out)
        return int(m.group(1)) if m else 0
    except Exception:
        return 0


def normalize(text: str) -> str:
    """채점용 정규화 — 공백·문장부호를 지운다."""
    return re.sub(r"[\s.,!?…·]", "", text)


def cer(reference: str, hypothesis: str) -> float:
    """문자 오류율. 편집 거리 / 정답 길이."""
    r, h = normalize(reference), normalize(hypothesis)
    if not r:
        return 0.0
    prev = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        cur = [i]
        for j, hc in enumerate(h, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rc != hc)))
        prev = cur
    return prev[-1] / len(r)


def measure_one(repo: str, audio_path: Path, use_hints: bool, runs: int) -> dict:
    """한 조합을 재고 결과를 dict 로 돌려준다. 자식 프로세스에서 실행된다."""
    import mlx_whisper

    audio, sr = sf.read(audio_path, dtype="float32")
    duration = len(audio) / sr
    base = rss_mb()

    latencies, text = [], ""
    for _ in range(runs):
        t = time.perf_counter()
        out = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=repo,
            language="ko",
            initial_prompt=HINTS if use_hints else None,
        )
        latencies.append((time.perf_counter() - t) * 1000)
        text = out.get("text", "")

    ms = statistics.median(latencies)
    return {
        "latencyMs": round(ms),
        "rtf": round(ms / 1000 / duration, 3),
        "rssMb": round(rss_mb() - base, 1),
        "peakRssMb": round(rss_mb(), 1),
        "text": text.strip(),
    }


def run_child(repo: str, audio: Path, use_hints: bool, runs: int) -> dict:
    """자식 프로세스를 띄워 한 조합을 잰다.

    모델을 같은 프로세스에서 연달아 로드하면 앞 모델이 캐시에 남아
    메모리 증가분을 분리할 수 없다. 프로세스를 나누는 것이 유일한 방법이다.
    """
    import subprocess
    import sys as _sys

    proc = subprocess.run(
        [_sys.executable, __file__, "--child", repo, str(audio),
         "1" if use_hints else "0", str(runs)],
        capture_output=True, text=True,
    )
    for line in reversed(proc.stdout.splitlines()):
        if line.startswith("{"):
            return json.loads(line)
    raise RuntimeError(proc.stderr.strip()[-200:] or "자식 프로세스가 결과를 내지 않음")


def main() -> None:
    import sys as _sys

    if len(_sys.argv) > 1 and _sys.argv[1] == "--child":
        _, _, repo, audio, hints, runs = _sys.argv
        print(json.dumps(measure_one(Path(audio).parent and repo, Path(audio),
                                     hints == "1", int(runs)), ensure_ascii=False))
        return

    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="*", default=list(REPOS))
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument(
        "--audio", type=Path, default=ROOT / "samples" / "ko_dev_16k.wav"
    )
    args = ap.parse_args()

    if not args.audio.exists():
        raise SystemExit(f"샘플이 없습니다: {args.audio}\n먼저 bench/make_test_sample.py 를 돌리세요.")

    import mlx_whisper

    audio, sr = sf.read(args.audio, dtype="float32")
    assert sr == 16000, f"Whisper 는 16kHz 를 먹습니다 (지금 {sr})"
    duration = len(audio) / sr
    reference = (ROOT / "samples" / "ko_dev.txt").read_text(encoding="utf-8")

    print(f"기계   : {platform.machine()} / macOS")
    print(f"샘플   : {args.audio.name} · {duration:.1f}s · 정답 {len(normalize(reference))}자\n")

    report = {
        "when": datetime.now().isoformat(),
        "machine": platform.platform(),
        "audioSec": round(duration, 1),
        "results": {},
    }

    print(f"{'모델':<16}{'힌트':>5}{'지연ms':>8}{'RTF':>7}{'RSS MB':>9}{'CER':>7}{'스왑':>6}")
    print("-" * 60)

    for name in args.models:
        repo = REPOS.get(name)
        if repo is None:
            print(f"{name:<16} 알 수 없는 모델 — 건너뜀")
            continue

        for use_hints in (False, True):
            swap_before = swap_out()
            try:
                r = run_child(repo, args.audio, use_hints, args.runs)
            except Exception as exc:
                print(f"{name:<16}{'예' if use_hints else '아니오':>5}  실패: {str(exc)[:40]}")
                continue

            r["cer"] = round(cer(reference, r["text"]), 4)
            r["swapDelta"] = swap_out() - swap_before
            report["results"][f"{name}/{'hints' if use_hints else 'plain'}"] = r
            print(
                f"{name:<16}{'예' if use_hints else '아니오':>5}{r['latencyMs']:>8}"
                f"{r['rtf']:>7.3f}{r['peakRssMb']:>9.1f}{r['cer']:>7.1%}{r['swapDelta']:>6}"
            )

    out_dir = ROOT / "bench" / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"whisper-mlx-{datetime.now():%Y%m%d-%H%M%S}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n기록: {path}")
    print("\n판정: 스왑 증가 0 · RTF < 1.0 을 통과하는 것 중 CER 최저 모델을 채택")


if __name__ == "__main__":
    main()
