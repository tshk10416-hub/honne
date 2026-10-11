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

// ワード・スナイパー：相手（opponent）の回答から、自分が言わせるワードを決める。
// exclude に入っている語（このラウンドで使用済み）は避ける。
export async function pickSniperWord(opponent, exclude = []) {
  const candidates = [];
  answeredQuestions(opponent).forEach((q) => {
    const choice = opponent.survey[q.id];
    const opt = q.options[choice];
    opt.targetWords.forEach((word) => candidates.push({
      targetWord: word,
      source: 'survey',
      sourceRef: `${q.id}.${choice}`,
      sourceLabel: `相手のアンケート「${q.text}」の回答「${opt.label}」から`,
      hintTheme: q.theme,
    }));
  });
  const fresh = candidates.filter((c) => !exclude.includes(c.targetWord));
  if (fresh.length) return pick(fresh);

  // 相手が未回答（または使い切った）ときはプリセットのトークテーマから
  const presets = (await loadPresets()).filter((t) => t.modes.includes('sniper') && t.targetWords.length);
  const presetCandidates = [];
  presets.forEach((t) => t.targetWords.forEach((word) => presetCandidates.push({
    targetWord: word,
    source: 'preset',
    sourceRef: `preset:${t.id}`,
    sourceLabel: `トークテーマ「${t.text}」から`,
    hintTheme: t.text,
  })));
  const freshPresets = presetCandidates.filter((c) => !exclude.includes(c.targetWord));
  return pick(freshPresets.length ? freshPresets : presetCandidates);
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
