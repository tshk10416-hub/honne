// お題の抽出ロジック（フォールバック込み）。
// アンケート回答があればそこから、なければプリセット50問から抽選してゲームを止めない。
import { SURVEY } from './survey.js';

let presetCache = null;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export async function loadPresets() {
  if (presetCache) return presetCache;
  const res = await fetch(new URL('../data/presets.json', import.meta.url));
  if (!res.ok) throw new Error(`presets.json の読み込みに失敗しました (${res.status})`);
  presetCache = (await res.json()).topics;
  return presetCache;
}

// 条件に合うプリセットを1つ抽選。出題済み（excludeRefs）を避け、尽きたら重複を許す。
export async function pickPreset({ type, mode, minSpicy = 1, excludeRefs = [] } = {}) {
  const all = await loadPresets();
  let pool = all.filter((t) => (!type || t.type === type)
    && (!mode || t.modes.includes(mode))
    && t.spicy >= minSpicy);
  const fresh = pool.filter((t) => !excludeRefs.includes(`preset:${t.id}`));
  if (fresh.length) pool = fresh;
  return pool.length ? pick(pool) : null;
}

export function answeredQuestions(player) {
  const survey = player?.survey || {};
  return SURVEY.filter((q) => survey[q.id] === 'A' || survey[q.id] === 'B');
}

// ワード・スナイパー：相手（opponent）の回答から、自分が言わせるワードを決める
export async function pickSniperWord(opponent) {
  const answered = answeredQuestions(opponent);
  if (answered.length) {
    const q = pick(answered);
    const choice = opponent.survey[q.id];
    return {
      targetWord: pick(q.options[choice].targetWords),
      source: 'survey',
      sourceRef: `${q.id}.${choice}`,
      hintTheme: q.theme,
    };
  }
  const t = await pickPreset({ type: 'talk', mode: 'sniper' });
  return {
    targetWord: pick(t.targetWords),
    source: 'preset',
    sourceRef: `preset:${t.id}`,
    hintTheme: t.text,
  };
}

// プロファイル・ベット：主役の回答済みの問いから出題。なければプリセット＋主役の即決（needsStance）。
// 正解（answer）を含むため、主役本人の端末で呼ぶこと。
export async function pickBetQuestion(protagonist, usedRefs = []) {
  const name = protagonist?.nickname || '主役';
  const fresh = answeredQuestions(protagonist).filter((q) => !usedRefs.includes(`survey:${q.id}`));
  if (fresh.length) {
    const q = pick(fresh);
    return {
      question: {
        text: q.betPrompt.replace('{name}', name),
        optionA: q.options.A.label,
        optionB: q.options.B.label,
        source: 'survey',
        ref: `survey:${q.id}`,
      },
      answer: protagonist.survey[q.id],
      needsStance: false,
    };
  }
  const t = await pickPreset({ type: 'binary', mode: 'bet', excludeRefs: usedRefs });
  return {
    question: {
      text: `${name}さんは、${t.text}`,
      optionA: t.optionA,
      optionB: t.optionB,
      source: 'preset',
      ref: `preset:${t.id}`,
    },
    answer: null,
    needsStance: true,
  };
}

// アノニマス・ターゲット：きわどめ（spicy 2以上）のお題から抽選
export async function pickAnonymousQuestion(usedRefs = []) {
  const t = await pickPreset({ mode: 'anonymous', minSpicy: 2, excludeRefs: usedRefs });
  return {
    text: t.text,
    optionA: t.optionA,
    optionB: t.optionB,
    source: 'preset',
    ref: `preset:${t.id}`,
  };
}
