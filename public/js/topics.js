// お題の抽出ロジック（フォールバック込み）。
// アンケート回答があればそこから、なければプリセット50問から抽選してゲームを止めない。
import { SURVEY } from './survey.js';
import { QUIZ } from './quiz.js';

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

// ワード・スナイパー：相手（opponent）が選んだ回答そのものの言葉を、自分が言わせるワードにする。
// そのワードを言わせるための質問例（questions）と、相手の回答（hintAnswer）も一緒に返す。
// exclude に入っている語（このラウンドで使用済み）は避け、まだ出していない問いの語を優先する。
export async function pickSniperWord(opponent, exclude = []) {
  const name = opponent?.nickname || '相手';
  const candidates = [];
  answeredQuestions(opponent).forEach((q) => {
    const choice = opponent.survey[q.id];
    const opt = q.options[choice];
    opt.targetWords.forEach(({ word, questions }) => candidates.push({
      targetWord: word,
      questions,
      source: 'survey',
      sourceRef: `${q.id}.${choice}`,
      sourceLabel: `相手のアンケート「${q.text}」の回答「${opt.label}」から`,
      hintTheme: q.theme,
      hintAnswer: `${name}さんは「${q.text}」に「${opt.label}」と回答`,
    }));
  });
  const picked = pickFresh(candidates, exclude);
  if (picked) return picked;

  // 相手が未回答（または使い切った）ときはプリセットのトークテーマから
  const presets = (await loadPresets()).filter((t) => t.modes.includes('sniper') && t.targetWords.length);
  const presetCandidates = [];
  presets.forEach((t) => t.targetWords.forEach(({ word, questions }) => presetCandidates.push({
    targetWord: word,
    questions,
    source: 'preset',
    sourceRef: `preset:${t.id}`,
    sourceLabel: `トークテーマ「${t.text}」から`,
    hintTheme: t.text,
    hintAnswer: `アンケートの回答が足りないので、トークテーマ「${t.text}」から出題`,
  })));
  return pickFresh(presetCandidates, exclude) || pick(presetCandidates);
}

// 使用済みの語を除いて抽選。同じ問い（sourceRef）の語が続かないよう、未使用の問いを優先する。
function pickFresh(candidates, exclude) {
  const fresh = candidates.filter((c) => !exclude.includes(c.targetWord));
  if (!fresh.length) return null;
  const usedRefs = new Set(candidates.filter((c) => exclude.includes(c.targetWord)).map((c) => c.sourceRef));
  const unusedTopic = fresh.filter((c) => !usedRefs.has(c.sourceRef));
  return pick(unusedTopic.length ? unusedTopic : fresh);
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

// 時限爆弾解除：その人の解除コードになる問題を DEFUSE_DIGITS 問選ぶ（本人の端末で呼ぶ）。
// 回答済みのアンケートから選び、足りない分は直感2択クイズで補う（クイズは本人がその場で答える）。
//   codes … 相手の画面に出す問題（答えは含まない）。お題をそのまま聞くのは禁止なので、遠回しな質問の例（examples）も付ける
//   keys  … アンケートから決まった答え。クイズの分は null（本人の回答待ち）
//   exclude … 使わない問題の ref（相手の解除コードと同じ問題が出ないようにする）
export function pickDefuseCode(player, digits, exclude = []) {
  const survey = player?.survey || {};
  const surveyPool = answeredQuestions(player).filter((q) => !exclude.includes(`survey:${q.id}`));
  const fromSurvey = shuffle(surveyPool).slice(0, digits).map((q) => ({
    code: {
      ref: `survey:${q.id}`,
      source: 'survey',
      text: q.text,
      topic: q.theme,
      options: { A: q.options.A.label, B: q.options.B.label },
      // 遠回しな質問の例（並びはランダムで、画面には1つ目を出す）
      examples: shuffle(q.defuseHints || []),
    },
    key: survey[q.id],
  }));
  const quizPool = QUIZ.filter((z) => !exclude.includes(`quiz:${z.id}`));
  const fromQuiz = shuffle(quizPool).slice(0, digits - fromSurvey.length).map((z) => ({
    code: {
      ref: `quiz:${z.id}`,
      source: 'quiz',
      text: z.text,
      topic: z.topic,
      options: { ...z.options },
      examples: z.hint ? [z.hint] : [],
    },
    key: null,
  }));
  const all = shuffle([...fromSurvey, ...fromQuiz]);
  return { codes: all.map((c) => c.code), keys: all.map((c) => c.key) };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
