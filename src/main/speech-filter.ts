/**
 * 음성으로 나갈 텍스트를 다듬는다 (기획서 8.2절 이중 방어).
 *
 * 시스템 프롬프트에 "코드를 읽지 마라"고 적어두는 것만으로는 보장되지 않는다.
 * Claude 가 규칙을 어겨도 여기서 제거된다. 화면에는 원문이 그대로 남고,
 * 음성만 걸러진다.
 *
 * | 내용 | 화면 | 음성 |
 * |---|---|---|
 * | 일반 대화 | 전문 | 전문 |
 * | 코드 | 전문 | 읽지 않음 — "작성했습니다" |
 * | 긴 문서·표 | 전문 | "파일로 만들어 뒀습니다" |
 * | 목록 | 전문 | 항목 수와 요지 |
 * | 링크 | 전문 | 읽지 않음 |
 */

export interface FilterResult {
  /** 음성으로 읽을 텍스트. 비어 있으면 말하지 않는다. */
  speech: string;
  /** 무엇을 어떻게 바꿨는지. 로그와 시험용. */
  notes: string[];
}

/** 코드 블록 하나를 한 문장으로 요약한다. */
function describeCodeBlock(lang: string, body: string): string {
  const lines = body.trim().split('\n').length;
  const language = lang.trim();
  if (language) return `${language} 코드 ${lines}줄을 작성했습니다.`;
  return `코드 ${lines}줄을 작성했습니다.`;
}

/** 표를 한 문장으로 요약한다. */
function describeTable(rows: number): string {
  // 머리글과 구분선을 뺀 실제 항목 수
  const items = Math.max(0, rows - 2);
  return items > 0 ? `${items}개 항목의 표를 화면에 띄웠습니다.` : '표를 화면에 띄웠습니다.';
}

const RULES: Array<{
  name: string;
  apply: (text: string, notes: string[]) => string;
}> = [
  {
    // 펜스 코드 블록. 가장 먼저 처리해야 안쪽 내용이 다른 규칙에 걸리지 않는다.
    name: 'code-block',
    apply: (text, notes) =>
      text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) => {
        notes.push('코드 블록 → 요약');
        return ` ${describeCodeBlock(lang, body)} `;
      }),
  },
  {
    name: 'table',
    apply: (text, notes) => {
      // 파이프로 구분된 줄이 2줄 이상 연속되면 표로 본다.
      const table = /(?:^[ \t]*\|.*\|[ \t]*$\n?){2,}/gm;
      return text.replace(table, (block) => {
        notes.push('표 → 요약');
        return ` ${describeTable(block.trim().split('\n').length)} `;
      });
    },
  },
  {
    name: 'inline-code',
    apply: (text, notes) =>
      text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
        // 짧은 식별자는 그냥 읽는다. 긴 것만 걷어낸다.
        if (code.length <= 20) return code;
        notes.push('긴 인라인 코드 → 제거');
        return '';
      }),
  },
  {
    name: 'link',
    apply: (text, notes) => {
      let touched = false;
      const withText = text.replace(/\[([^\]]+)\]\([^)]+\)/g, (_m, label: string) => {
        touched = true;
        return label; // 링크 주소는 읽지 않고 글자만 남긴다
      });
      const bare = withText.replace(/https?:\/\/\S+/g, () => {
        touched = true;
        return '';
      });
      if (touched) notes.push('링크 주소 → 제거');
      return bare;
    },
  },
  {
    name: 'markdown-marks',
    apply: (text, notes) => {
      const before = text;
      const out = text
        .replace(/^#{1,6}\s+/gm, '')          // 제목 기호
        .replace(/\*\*([^*]+)\*\*/g, '$1')    // 굵게
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1') // 기울임
        .replace(/~~([^~]+)~~/g, '$1')        // 취소선
        .replace(/^\s*>\s?/gm, '')            // 인용
        .replace(/^\s*[-*_]{3,}\s*$/gm, '');  // 구분선
      if (out !== before) notes.push('마크다운 기호 → 제거');
      return out;
    },
  },
  {
    name: 'list',
    apply: (text, notes) => {
      // 목록 항목이 5개를 넘으면 개수만 말한다 (8.2절: "항목 수와 요지").
      const lines = text.split('\n');
      const isItem = (l: string) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l);
      const out: string[] = [];
      let run: string[] = [];

      const flush = () => {
        if (run.length === 0) return;
        if (run.length > 5) {
          notes.push(`목록 ${run.length}개 → 개수만`);
          out.push(`${run.length}가지를 화면에 정리했습니다.`);
        } else {
          // 짧은 목록은 그대로 읽되 글머리 기호만 뗀다.
          out.push(...run.map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')));
        }
        run = [];
      };

      for (const line of lines) {
        if (isItem(line)) run.push(line);
        else {
          flush();
          out.push(line);
        }
      }
      flush();
      return out.join('\n');
    },
  },
  {
    name: 'whitespace',
    apply: (text) =>
      text
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .split('\n')
        .map((l) => l.trim())
        .join('\n')
        .trim(),
  },
];

/** 음성 출력 상한. 이보다 길면 화면으로 넘긴다. */
const MAX_SPEECH_CHARS = 600;

export function filterForSpeech(text: string): FilterResult {
  const notes: string[] = [];
  let out = text;
  for (const rule of RULES) out = rule.apply(out, notes);

  if (out.length > MAX_SPEECH_CHARS) {
    // 문장 경계에서 자른다. 말이 중간에 끊기면 이상하다.
    const cut = out.slice(0, MAX_SPEECH_CHARS);
    const lastStop = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    out = (lastStop > MAX_SPEECH_CHARS * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim();
    out += ' 나머지는 화면에 띄워 뒀습니다.';
    notes.push('길이 초과 → 화면으로');
  }

  return { speech: out, notes };
}

/**
 * 스트리밍 중 완성된 문장을 떼어낸다.
 *
 * Claude 응답을 기다렸다가 한 번에 말하면 몇 초를 침묵한다. 문장이 끝나는
 * 대로 흘려보내면 첫 소리가 훨씬 빨라진다.
 *
 * @returns [완성된 문장들, 아직 완성되지 않은 나머지]
 */
export function takeCompleteSentences(buffer: string): [string[], string] {
  const sentences: string[] = [];
  const pattern = /[^.!?…\n]*[.!?…]+[\s]*/g;
  let consumed = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(buffer)) !== null) {
    const sentence = match[0].trim();
    if (sentence) sentences.push(sentence);
    consumed = match.index + match[0].length;
  }
  return [sentences, buffer.slice(consumed)];
}
