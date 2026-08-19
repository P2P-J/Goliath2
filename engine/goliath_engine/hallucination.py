"""Whisper 환각 방지 (기획서 8.5절).

Whisper 는 무음·잡음 구간에서 없는 말을 지어낸다. 한국어에서는 학습 데이터에
자막이 많이 섞인 탓에 "시청해주셔서 감사합니다" 같은 상용구가 특히 자주 나온다.
대비하지 않으면 골리앗이 혼자 깨어나 엉뚱한 소리에 답한다.

4중 대책
  ① VAD 필터로 무음 구간 제거   → microphone.UtteranceCollector 가 담당
  ② 발화 길이가 임계 이하면 폐기
  ③ 알려진 환각 문구 블랙리스트 차단
  ④ 인식 신뢰도가 낮으면 되묻기

②~④ 가 이 파일이다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum


class Verdict(str, Enum):
    ACCEPT = "accept"
    #: 폐기 — 조용히 대기로 돌아간다. 사용자에게 알리지 않는다.
    DISCARD = "discard"
    #: 되물음 — 알아듣지 못했다고 말한다.
    ASK_AGAIN = "ask_again"


@dataclass
class Judgement:
    verdict: Verdict
    reason: str | None = None


#: 한국어 Whisper 가 무음에서 흔히 뱉는 자막 상용구.
#: 전체 발화가 이것뿐일 때만 막는다 — 실제로 이렇게 말할 수도 있기 때문이다.
BLACKLIST = [
    "시청해주셔서감사합니다",
    "시청해주셔서감사합니다다음영상에서만나요",
    "구독과좋아요부탁드립니다",
    "구독좋아요알림설정",
    "다음영상에서만나요",
    "한글자막by",
    "자막제공",
    "이영상은유료광고를포함하고있습니다",
    "끝까지시청해주셔서감사합니다",
    "영상편집",
    "mbc뉴스",
    "kbs뉴스",
    "sbs뉴스",
]

#: 최소 발화 길이. 이보다 짧으면 웨이크워드 잔향이거나 잡음이다.
MIN_DURATION_SEC = 0.35
#: 발화로 판정된 구간의 최소 길이. 프리롤과 무음을 뺀 실제 말의 양이다.
MIN_SPEECH_SEC = 0.4
#: 발화로 판정된 프레임 비율의 하한.
#:
#: 낮게 잡는 이유: 이 비율은 구조적으로 희석된다. 앞쪽 소음 구간과 뒤쪽
#: 침묵 1.2초가 모두 분모에 들어가므로, 1.5초를 말해도 20% 남짓이 된다.
#: 실측에서 소음 섞인 정상 발화가 16% 로 나와 임계 15% 에 간신히 걸렸다.
#: 실제 방어는 MIN_SPEECH_SEC(절대 발화량)과 수집기의 히스테리시스가 한다 —
#: 소음만 있으면 수집이 시작조차 되지 않는다.
MIN_SPEECH_RATIO = 0.08
#: 최소 글자 수 (공백 제외).
MIN_CHARS = 2

#: Whisper 가 내는 신호들의 임계.
MAX_NO_SPEECH_PROB = 0.6      # 이보다 높으면 말이 없었다고 본다
MIN_AVG_LOGPROB = -1.0        # 이보다 낮으면 확신이 없다
MAX_COMPRESSION_RATIO = 2.4   # 이보다 높으면 같은 말을 반복하고 있다


def _normalize(text: str) -> str:
    """비교용 정규화 — 공백·문장부호·대소문자를 지운다."""
    return re.sub(r"[\s.,!?~…'\"·\-]", "", text).lower()


def _is_repetitive(text: str) -> bool:
    """같은 어절이 네 번 이상 연속되면 환각으로 본다."""
    words = text.split()
    if len(words) < 4:
        return False
    run = 1
    for a, b in zip(words, words[1:]):
        run = run + 1 if a == b else 1
        if run >= 4:
            return True
    return False


def prejudge(
    *, duration_sec: float, speech_sec: float, speech_ratio: float
) -> Judgement:
    """인식 **전** 에 값싼 검사를 먼저 통과시킨다.

    대부분 소음인 오디오를 Whisper 에 넘기면 온도 폴백이 반복되어 4초 발화에
    10초가 걸린다. 그러고 나온 결과는 어차피 폐기된다. 넘기지 않는 것이 맞다.
    """
    if duration_sec < MIN_DURATION_SEC:
        return Judgement(Verdict.DISCARD, "too_short")
    if speech_sec < MIN_SPEECH_SEC:
        return Judgement(Verdict.DISCARD, "too_short")
    if speech_ratio < MIN_SPEECH_RATIO:
        return Judgement(Verdict.DISCARD, "silence")
    return Judgement(Verdict.ACCEPT)


def judge(
    text: str,
    *,
    duration_sec: float,
    speech_ratio: float,
    no_speech_prob: float | None = None,
    avg_logprob: float | None = None,
    compression_ratio: float | None = None,
) -> Judgement:
    """인식 결과를 받아들일지 판정한다.

    폐기(DISCARD)는 조용히 넘어간다 — 잡음에 매번 "못 알아들었습니다"라고
    답하면 그게 더 시끄럽다. 되물음(ASK_AGAIN)은 사람이 말은 했는데
    알아듣지 못한 경우다.
    """
    stripped = text.strip()
    normalized = _normalize(stripped)

    # ② 길이
    if duration_sec < MIN_DURATION_SEC:
        return Judgement(Verdict.DISCARD, "too_short")
    if speech_ratio < MIN_SPEECH_RATIO:
        return Judgement(Verdict.DISCARD, "silence")
    if len(normalized) < MIN_CHARS:
        return Judgement(Verdict.DISCARD, "too_short")

    # ③ 블랙리스트 — 발화 전체가 상용구일 때만
    if normalized in BLACKLIST:
        return Judgement(Verdict.DISCARD, "blacklisted")
    if _is_repetitive(stripped):
        return Judgement(Verdict.DISCARD, "blacklisted")

    # ④ 신뢰도
    if no_speech_prob is not None and no_speech_prob > MAX_NO_SPEECH_PROB:
        return Judgement(Verdict.DISCARD, "silence")
    if compression_ratio is not None and compression_ratio > MAX_COMPRESSION_RATIO:
        return Judgement(Verdict.DISCARD, "blacklisted")
    if avg_logprob is not None and avg_logprob < MIN_AVG_LOGPROB:
        # 말은 했는데 못 알아들었다 — 이건 되묻는 게 맞다.
        return Judgement(Verdict.ASK_AGAIN, "low_confidence")

    return Judgement(Verdict.ACCEPT)
