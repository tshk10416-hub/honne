// S30 マッチング / S31 お題提示 / S32 尋問 / S33 ベット / S34 ショーダウン / S35 ギャップ・トーク / S36 最終結果
//   bet.html?opponent=<uid>  1対1：モード選択で「ステータス・ベット」を選んだとき（対戦に参加して ?duel= に置き換える）
//   bet.html?duel=<duelId>   1対1：挑戦の受諾・再読み込み・もう一度
//   bet.html?room=<roomId>   複数人（3〜6人）：ホストがロビーで「ステータス・ベット」を選んだとき
//
// 全員1,000コインから。1ターンの流れ（約90秒）：
//   お題提示（10秒）→ 尋問タイム（45秒）→ ベット（15秒）→ ショーダウン → ギャップ・トーク（20秒＋「次のラウンドへ」）
//   1対1  … 全3ラウンド。毎ラウンド2人ともお題が出て、お互いに相手のお題に賭ける。
//   複数人 … 主役が1人ずつ交代（全員が1回ずつ主役）。主役以外の全員が、主役の答えに賭ける。
//   当たれば賭け金の2倍が戻り（＋賭け金）、外れたら賭け金を失う。ALL IN は持ちコインすべて。
//   主役がアンケート未回答なら、プリセットのお題を出し、主役が3秒以内にこっそり A/B を選ぶ（時間切れはランダム）。
//
// 進行（フェーズの切り替え）は、1対1なら2人のどちらかの端末、複数人ならホストの端末が書き込む。
// フェーズの開始時刻（phaseAt）はサーバー時刻なので、全員の画面で同じ残り時間になる。
// 持ちコインは保存せず、賭けの記録と答えから毎回計算する（全員の画面で同じ結果になる）。
//
// データの置き場所（Firestore のセキュリティルールは変更なし）
//   1対1  … duels/pair_* の対戦ドキュメント（mode: 'bet'）に turns / answers / bets
//   複数人 … rooms/{id} の bet（ホストが書き込む）と、各自の rooms/{id}/members/{uid} の betPlays.{gameId}
//            （賭けと、こっそり選んだ答え。本人が書き込む）。ショーダウンでホストが bet に書き写して確定する。
import { signIn, isLocalMode, randomId } from './firebase.js';
import {
  store, toMillis, duelModeOf, duelPage, SERVER_TIME,
  BET_START_COINS, BET_DUEL_TURNS, BET_STAKES,
} from './store.js';
import { pickBetQuestion } from './topics.js';
import {
  $, avatarHtml, escapeHtml, show, toast, errorMessage, showFatal, showLocalBanner,
} from './ui.js';

const params = new URLSearchParams(location.search);
const KEYS = ['A', 'B'];
const SUITS = { A: '♥', B: '♠' };
const PHASES = ['setup', 'talk', 'bet', 'showdown', 'gap'];
const PHASE_NAMES = {
  setup: 'お題提示',
  talk: '尋問タイム',
  bet: 'ベット',
  showdown: 'ショーダウン',
  gap: 'ギャップ・トーク',
};
// 各フェーズの秒数（ギャップ・トークは目安。「次のラウンドへ」を押すまで続く）
const DURATION = {
  setup: 10, talk: 45, bet: 15, showdown: 6, gap: 20,
};
const STANCE_MS = 3000; // こっそり選ぶ制限時間
const DRUM_MS = 2400; // ショーダウン：ドラムロールのあと答えのカードがめくれる
const VERDICT_MS = 3000; // ショーダウン：当たり外れとコインの増減を出す
const HURRY_SECONDS = 5;
const HEARTBEAT_MS = 30 * 1000;
const TICK_MS = 200;

const state = {
  uid: null,
  me: null,
  kind: null, // 'duel'（1対1）/ 'room'（複数人）
  id: null, // 対戦ID またはルームID
  duel: null,
  room: null,
  members: [],
  opponent: null, // 1対1の相手（ローカルモードのテスト相手かどうかの判定に使う）
  G: null, // 1対1と複数人をそろえた形のゲーム状態（normalize の結果）
  sel: { key: null, pick: null, stake: null, sent: null }, // ベット画面で選んでいる答えと賭け金
  inflight: new Set(), // 同じ書き込みを重ねて送らないための目印
  stance: { key: null, shownAt: 0 },
  phaseKey: null, // フェーズが変わった瞬間（振動）の判定
  revealedFor: null, // ショーダウンの演出を出したターン
  coinShown: null, // 画面に出している自分のコイン（増減のアニメーション用）
  creating: false,
  leaving: false,
};

/* ------------------------------------------------------------------ */
/* 共通                                                                */
/* ------------------------------------------------------------------ */

const VIEWS = ['loading', 'waiting', 'play', 'final', 'cancelled'];
function showView(name) {
  VIEWS.forEach((v) => show($(`#view-${v}`), v === name));
}

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

function tKey(t) {
  return `t${t}`;
}

function formatCoins(n) {
  return Number(n || 0).toLocaleString('ja-JP');
}

// 同じ内容なら DOM を書き換えない（タイマーの更新のたびに作り直すと、タップが消えることがあるため）
function setHtml(el, html) {
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function playerOf(id) {
  return state.G?.players?.[id] || { nickname: '？' };
}

function nameOf(id) {
  if (id === state.uid) return 'あなた';
  return `${playerOf(id).nickname}さん`;
}

// 書き込み中の同じ処理を重ねない。失敗は console に残し、notify のときだけ画面にも出す
async function act(name, fn, notify = false) {
  if (state.inflight.has(name)) return;
  state.inflight.add(name);
  try {
    await fn();
  } catch (err) {
    console.warn(err);
    if (notify) toast(errorMessage(err), 'error');
  } finally {
    state.inflight.delete(name);
  }
}

/* ------------------------------------------------------------------ */
/* ゲーム状態をそろえる（1対1と複数人の違いはここで吸収する）            */
/* ------------------------------------------------------------------ */

function normalizeDuel(d) {
  const players = {};
  d.playerIds.forEach((id) => {
    players[id] = {
      ...(d.players?.[id] || { nickname: '？' }),
      isDummy: id !== state.uid && !!state.opponent?.isDummy,
    };
  });
  return {
    kind: 'duel',
    gameId: `${d.id}:${d.round}`,
    status: d.status,
    playerIds: d.playerIds,
    players,
    totalTurns: d.totalTurns || BET_DUEL_TURNS,
    turnIndex: d.turnIndex ?? -1,
    phase: d.phase || null,
    phaseAt: toMillis(d.phaseAt),
    turns: d.turns || {},
    answers: d.answers || {},
    bets: d.bets || {},
    driver: true, // 1対1は2人とも進行を書き込める（同時に書いてもトランザクションで1回になる）
  };
}

// 複数人：ホストが書いた bet に、各自の members ドキュメントの賭け・答えを合わせる。
// ショーダウンでホストが書き写したターン（frozen）は、その記録だけを使う（締切後の書き込みは無視）。
function normalizeRoom(room, members) {
  const b = room.bet;
  if (!b) return null;
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  const players = {};
  b.order.forEach((id) => {
    const m = byId[id];
    players[id] = {
      nickname: m?.nickname || b.players?.[id]?.nickname || '？',
      color: m?.color || b.players?.[id]?.color,
      isDummy: !!m?.isDummy,
    };
  });
  const answers = {};
  const bets = {};
  Object.entries(b.turns || {}).forEach(([key, turn]) => {
    answers[key] = { ...(b.answers?.[key] || {}) };
    bets[key] = { ...(b.bets?.[key] || {}) };
    if (b.frozen?.[key]) return;
    members.forEach((m) => {
      const play = m.betPlays?.[b.gameId];
      if (!play) return;
      const stance = play.stances?.[key];
      if (turn.targets.includes(m.id) && turn.needsStance?.[m.id] && KEYS.includes(stance) && !answers[key][m.id]) {
        answers[key][m.id] = stance;
      }
      const bet = play.bets?.[key];
      if (bet && !turn.targets.includes(m.id)) bets[key][m.id] = bet;
    });
  });
  return {
    kind: 'room',
    gameId: b.gameId,
    status: b.status,
    playerIds: b.order,
    players,
    totalTurns: b.totalTurns,
    turnIndex: b.turnIndex ?? -1,
    phase: b.phase || null,
    phaseAt: toMillis(b.phaseAt),
    turns: b.turns || {},
    answers,
    bets,
    driver: room.hostId === state.uid, // 複数人はホストだけが進行を書き込める
  };
}

function recompute() {
  if (state.kind === 'duel') {
    state.G = state.duel ? normalizeDuel(state.duel) : null;
  } else {
    state.G = state.room ? normalizeRoom(state.room, state.members) : null;
  }
}

// t ターン目に賭ける人と、その人が賭ける相手（1対1はお互い、複数人は主役以外の全員が主役に）
function bettorsOf(G, t) {
  const turn = G.turns[tKey(t)];
  if (!turn) return [];
  if (G.kind === 'duel') {
    return G.playerIds.map((id) => ({ bettor: id, target: G.playerIds.find((x) => x !== id) }));
  }
  return G.playerIds
    .filter((id) => !turn.targets.includes(id))
    .map((id) => ({ bettor: id, target: turn.targets[0] }));
}

// 答えが公開済み（コインの計算に入れる）の最後のターン
function settledUpTo(G) {
  if (G.status === 'finished') return G.turnIndex;
  if (G.phase === 'showdown' || G.phase === 'gap') return G.turnIndex;
  return G.turnIndex - 1;
}

// コインの計算：賭けの記録と答えから、ターンごとの増減と、いまの持ちコインを出す。
//   before … いまのターンの賭けが精算される前の持ちコイン（賭けられる上限）
//   rows   … ターンごとの精算 { t, results: { 賭けた人: { pick, amount, target, answer, hit, delta } } }
function ledger(G) {
  const coins = Object.fromEntries(G.playerIds.map((id) => [id, BET_START_COINS]));
  const last = settledUpTo(G);
  const rows = [];
  let before = null;
  for (let t = 0; t <= G.turnIndex && t < G.totalTurns; t += 1) {
    if (t === G.turnIndex) before = { ...coins };
    if (t > last) break;
    const key = tKey(t);
    const results = {};
    bettorsOf(G, t).forEach(({ bettor, target }) => {
      const bet = G.bets[key]?.[bettor];
      if (!bet) return;
      // 持ちコインより多い賭けは、持ちコインまで（ALL IN と同じ）
      const amount = Math.max(0, Math.min(Number(bet.amount) || 0, coins[bettor] ?? 0));
      const answer = G.answers[key]?.[target];
      // 主役が答えを選ばなかったターンは無効（賭け金はそのまま戻る）
      const hit = KEYS.includes(answer) ? bet.pick === answer : null;
      const delta = hit === null ? 0 : hit ? amount : -amount;
      results[bettor] = {
        pick: bet.pick, amount, target, answer, hit, delta,
      };
      coins[bettor] = (coins[bettor] ?? 0) + delta;
    });
    rows.push({ t, results });
  }
  return { coins, rows, before: before || { ...coins } };
}

function myBettorInfo(G, t) {
  return bettorsOf(G, t).find((b) => b.bettor === state.uid) || null;
}

// ベットの締切を待たずにショーダウンへ進めるか（賭けられる人が全員賭けた）
function allBet(G, t) {
  const { before } = ledger(G);
  const key = tKey(t);
  return bettorsOf(G, t)
    .filter(({ bettor }) => (before[bettor] ?? 0) > 0)
    .every(({ bettor }) => !!G.bets[key]?.[bettor]);
}

/* ------------------------------------------------------------------ */
/* 書き込み                                                            */
/* ------------------------------------------------------------------ */

// 進行の書き込み。fn には 1対1なら対戦ドキュメント、複数人ならルームの bet を渡し、その差分を返してもらう
function writeGame(fn) {
  if (state.kind === 'duel') return store.updateDuel(state.id, (d) => fn(d));
  return store.updateRoom(state.id, (room) => {
    if (!room.bet) return null;
    const patch = fn(room.bet);
    return patch ? { bet: { ...room.bet, ...patch } } : null;
  });
}

// このゲームで出題済みの問い（主役ごとのアンケートの問いと、全員共通のプリセット）
function usedRefsFor(G, id, picked) {
  const refs = [];
  Object.values(G.turns).forEach((turn) => {
    Object.entries(turn.questions || {}).forEach(([target, q]) => {
      if (target === id || q.source === 'preset') refs.push(q.ref);
    });
  });
  Object.values(picked).forEach((q) => {
    if (q.source === 'preset') refs.push(q.ref);
  });
  return refs;
}

// t ターン目を始める（最後のターンのあとなら最終結果へ）。お題はここで決める
async function startTurn(t) {
  const G = state.G;
  if (t >= G.totalTurns) {
    await writeGame((g) => (g.status === 'playing' && g.turnIndex === t - 1 && g.phase === 'gap'
      ? { status: 'finished', phase: null, phaseAt: SERVER_TIME }
      : null));
    return;
  }
  const targets = G.kind === 'duel' ? [...G.playerIds] : [G.playerIds[t % G.playerIds.length]];
  const questions = {};
  const needsStance = {};
  const answers = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const id of targets) {
    // eslint-disable-next-line no-await-in-loop
    const player = (await store.getPlayer(id)) || playerOf(id);
    // eslint-disable-next-line no-await-in-loop
    const picked = await pickBetQuestion(player, usedRefsFor(G, id, questions));
    questions[id] = picked.question;
    needsStance[id] = picked.needsStance;
    if (!picked.needsStance) answers[id] = picked.answer;
  }
  const key = tKey(t);
  await writeGame((g) => {
    if (g.status !== 'playing' || (g.turnIndex ?? -1) !== t - 1) return null;
    if (t > 0 && g.phase !== 'gap') return null;
    return {
      turnIndex: t,
      phase: 'setup',
      phaseAt: SERVER_TIME,
      turns: { ...(g.turns || {}), [key]: { targets, questions, needsStance } },
      answers: { ...(g.answers || {}), [key]: answers },
    };
  });
}

function advancePhase(t, from, to) {
  const G = state.G;
  const key = tKey(t);
  return writeGame((g) => {
    if (g.status !== 'playing' || g.turnIndex !== t || g.phase !== from) return null;
    const patch = { phase: to, phaseAt: SERVER_TIME };
    // 複数人：ショーダウンの時点の賭けと答えをホストが書き写して確定する
    if (G.kind === 'room' && to === 'showdown') {
      patch.bets = { ...(g.bets || {}), [key]: G.bets[key] || {} };
      patch.answers = { ...(g.answers || {}), [key]: G.answers[key] || {} };
      patch.frozen = { ...(g.frozen || {}), [key]: true };
    }
    return patch;
  });
}

// 主役がこっそり選んだ答え（actorId は本人、ローカルモードではテスト相手のこともある）
function setStance(actorId, t, pick) {
  const key = tKey(t);
  if (state.kind === 'duel') {
    return store.updateDuel(state.id, (d) => {
      if (d.turnIndex !== t || !d.turns?.[key]?.needsStance?.[actorId] || d.answers?.[key]?.[actorId]) return null;
      return { answers: { ...d.answers, [key]: { ...(d.answers?.[key] || {}), [actorId]: pick } } };
    });
  }
  return store.updateMember(state.id, actorId, { [`betPlays.${state.G.gameId}.stances.${key}`]: pick });
}

// 賭けの記録。1対1はベットの締切（フェーズ）をトランザクションの中で確かめる
function placeBet(actorId, t, bet) {
  const key = tKey(t);
  if (state.kind === 'duel') {
    return store.updateDuel(state.id, (d) => {
      if (d.status !== 'playing' || d.turnIndex !== t || d.phase !== 'bet' || d.bets?.[key]?.[actorId]) return null;
      return { bets: { ...d.bets, [key]: { ...(d.bets?.[key] || {}), [actorId]: bet } } };
    });
  }
  return store.updateMember(state.id, actorId, {
    [`betPlays.${state.G.gameId}.bets.${key}`]: { ...bet, at: SERVER_TIME },
  });
}

// 複数人：ホストが新しいゲームを用意する（ロビーから来たとき・もう一度）
async function createRoomGame(restart = false) {
  if (state.creating) return;
  state.creating = true;
  try {
    const byId = Object.fromEntries(state.members.map((m) => [m.id, m]));
    await store.updateRoom(state.id, (r) => {
      if (r.hostId !== state.uid || r.status !== 'playing' || r.mode !== 'profileBet') return null;
      if (r.bet && !(restart && r.bet.status === 'finished')) return null;
      const base = restart ? shuffle(r.memberIds) : (r.turnOrder || []).filter((id) => r.memberIds.includes(id));
      const order = [...base, ...r.memberIds.filter((id) => !base.includes(id))];
      const players = Object.fromEntries(order.map((id) => [id, {
        nickname: byId[id]?.nickname || '？',
        color: byId[id]?.color || null,
      }]));
      return {
        bet: {
          gameId: `g${randomId(10)}`,
          status: 'playing',
          order,
          players,
          totalTurns: order.length,
          turnIndex: -1,
          phase: null,
          phaseAt: null,
          turns: {},
          answers: {},
          bets: {},
          frozen: {},
          createdAt: SERVER_TIME,
        },
      };
    });
  } finally {
    state.creating = false;
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------------ */
/* 進行（タイマーが切れたらフェーズを進める）                            */
/* ------------------------------------------------------------------ */

function drive(G, now) {
  if (!G.driver || G.status !== 'playing') return;
  if (G.turnIndex < 0 || !G.phase) {
    act(`start:${G.gameId}:0`, () => startTurn(0));
    return;
  }
  // 書き込み直後でサーバー時刻がまだ届いていないときは待つ
  if (!G.phaseAt) return;
  const t = G.turnIndex;
  const elapsed = now - G.phaseAt;
  const k = `adv:${G.gameId}:${t}:${G.phase}`;
  if (G.phase === 'setup' && elapsed >= DURATION.setup * 1000) {
    act(k, () => advancePhase(t, 'setup', 'talk'));
  } else if (G.phase === 'talk' && elapsed >= DURATION.talk * 1000) {
    act(k, () => advancePhase(t, 'talk', 'bet'));
  } else if (G.phase === 'bet' && (elapsed >= DURATION.bet * 1000 || allBet(G, t))) {
    act(k, () => advancePhase(t, 'bet', 'showdown'));
  } else if (G.phase === 'showdown' && elapsed >= DURATION.showdown * 1000) {
    act(k, () => advancePhase(t, 'showdown', 'gap'));
  }
}

function nextRound() {
  const G = state.G;
  if (!G || !G.driver || G.phase !== 'gap') return;
  act(`start:${G.gameId}:${G.turnIndex + 1}`, () => startTurn(G.turnIndex + 1), true);
}

/* ------------------------------------------------------------------ */
/* 答えの秘密選択（アンケート未回答のお題）                              */
/* ------------------------------------------------------------------ */

function myStanceTurn(G) {
  if (G.status !== 'playing' || G.turnIndex < 0) return null;
  if (G.phase !== 'setup' && G.phase !== 'talk') return null;
  const key = tKey(G.turnIndex);
  const turn = G.turns[key];
  if (!turn?.targets.includes(state.uid) || !turn.needsStance?.[state.uid]) return null;
  if (G.answers[key]?.[state.uid]) return null;
  return { key, turn };
}

function renderStance(G, now) {
  const need = myStanceTurn(G);
  const modal = $('#stance');
  if (!need) {
    show(modal, false);
    return;
  }
  const stanceKey = `${G.gameId}:${need.key}`;
  if (state.stance.key !== stanceKey) {
    state.stance = { key: stanceKey, shownAt: now };
    const q = need.turn.questions[state.uid];
    $('#stance-question').textContent = q.text.replace(/^.+?さんは、/, '');
    $('#stance-A-label').textContent = q.optionA;
    $('#stance-B-label').textContent = q.optionB;
    vibrate([60, 40, 60]);
  }
  show(modal, true);
  const left = STANCE_MS - (now - state.stance.shownAt);
  setText($('#stance-count'), String(Math.max(0, Math.ceil(left / 1000))));
  // 3秒たっても選ばなければ、ランダムで決める
  if (left <= 0) chooseStance(KEYS[Math.floor(Math.random() * 2)]);
}

function chooseStance(pick) {
  const G = state.G;
  if (!G || !myStanceTurn(G)) return;
  const t = G.turnIndex;
  show($('#stance'), false);
  act(`stance:${G.gameId}:${t}`, () => setStance(state.uid, t, pick), true);
}

/* ------------------------------------------------------------------ */
/* S30 マッチング（1対1）                                              */
/* ------------------------------------------------------------------ */

function versusHtml(player, label, ready) {
  return `
    ${avatarHtml(player, 'lg')}
    <span class="versus-name">${escapeHtml(player.nickname)}</span>
    <span class="versus-state${ready ? ' is-ready' : ''}">${label}</span>`;
}

function renderWaiting() {
  const { duel, uid } = state;
  const oppId = duel.playerIds.find((id) => id !== uid);
  const opp = duel.players?.[oppId] || { nickname: '相手' };
  const meJoined = !!duel.joined?.[uid];
  const oppJoined = !!duel.joined?.[oppId];
  $('#wait-me').innerHTML = versusHtml(duel.players?.[uid] || state.me, meJoined ? '準備OK' : '未参加', meJoined);
  $('#wait-opp').innerHTML = versusHtml(opp, oppJoined ? '準備OK' : '参加待ち', oppJoined);
  show($('#wait-pending'), meJoined);
  show($('#wait-invite'), !meJoined);
  $('#wait-pending-text').textContent = `${opp.nickname}さんの参加を待っています`;
  $('#wait-invite-text').textContent = duel.round > 1
    ? `${opp.nickname}さんから「ステータス・ベット」の再挑戦です`
    : `${opp.nickname}さんから「ステータス・ベット」の挑戦が届いています`;
  showView('waiting');
}

/* ------------------------------------------------------------------ */
/* S31〜S35 ゲーム卓                                                   */
/* ------------------------------------------------------------------ */

// 自分の画面のお題カードに出すお題（1対1は相手のお題、複数人は主役のお題）
function cardTargetOf(G, turn) {
  if (G.kind === 'duel') return G.playerIds.find((id) => id !== state.uid);
  return turn.targets[0];
}

function stakeValue(stake, available) {
  if (stake === 'all') return available;
  return Number(stake) || 0;
}

function animateCoins(to) {
  const el = $('#play-coins');
  const from = state.coinShown;
  state.coinShown = to;
  if (from === null || from === to) {
    el.textContent = formatCoins(to);
    return;
  }
  const start = performance.now();
  const duration = 900;
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - p) ** 3;
    el.textContent = formatCoins(Math.round(from + (to - from) * eased));
    if (p < 1 && state.coinShown === to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  const delta = $('#play-delta');
  delta.textContent = `${to > from ? '+' : '−'}${formatCoins(Math.abs(to - from))}`;
  delta.className = `bank-delta ${to > from ? 'is-up' : 'is-down'}`;
  show(delta, true);
  // アニメーションをやり直すため、一度クラスを外して付け直す
  void delta.offsetWidth;
  delta.classList.add('is-pop');
  $('.bank-me').classList.toggle('is-up', to > from);
  $('.bank-me').classList.toggle('is-down', to < from);
}

function renderHead(G, now) {
  const t = G.turnIndex;
  setText($('#play-round'), `${t + 1}/${G.totalTurns}`);
  setText($('#play-phase'), PHASE_NAMES[G.phase] || '');
  const idx = PHASES.indexOf(G.phase);
  setHtml($('#play-steps'), PHASES.map((p, i) => `<span class="step${i < idx ? ' is-done' : ''}${i === idx ? ' is-now' : ''}"></span>`).join(''));

  const total = (DURATION[G.phase] || 0) * 1000;
  const left = G.phaseAt ? Math.max(0, total - (now - G.phaseAt)) : total;
  const timer = $('#play-timer');
  const showTimer = G.phase !== 'showdown';
  setText(timer, showTimer ? String(Math.ceil(left / 1000)) : '—');
  timer.classList.toggle('is-hurry', showTimer && G.phase !== 'gap' && left <= HURRY_SECONDS * 1000 && left > 0);
  $('#play-fuse').style.transform = `scaleX(${total ? left / total : 0})`;
}

function renderBank(G, revealed, book) {
  const t = G.turnIndex;
  const key = tKey(t);
  const shown = revealed ? book.coins : book.before;
  animateCoins(shown[state.uid] ?? BET_START_COINS);

  const turn = G.turns[key];
  const others = G.playerIds.filter((id) => id !== state.uid);
  const html = others.map((id) => {
    const isTarget = turn?.targets.includes(id) && G.kind === 'room';
    let tag = '';
    if (isTarget) tag = '<span class="bank-tag is-star">主役</span>';
    else if (G.phase === 'bet') tag = G.bets[key]?.[id] ? '<span class="bank-tag is-bet">BET済み</span>' : '<span class="bank-tag">考え中</span>';
    return `
      <li class="bank-other">
        ${avatarHtml(playerOf(id), 'sm')}
        <span class="bank-other-body">
          <span class="bank-other-name">${escapeHtml(playerOf(id).nickname)}</span>
          <span class="bank-other-coins">${formatCoins(shown[id] ?? BET_START_COINS)}</span>
        </span>
        ${tag}
      </li>`;
  }).join('');
  setHtml($('#play-others'), html);
}

function renderCard(G, turn, revealed, drumming) {
  const target = cardTargetOf(G, turn);
  const q = turn.questions[target];
  const key = tKey(G.turnIndex);
  const answer = G.answers[key]?.[target];
  const iAmStar = target === state.uid;

  let who = '相手のお題';
  if (G.kind === 'room') who = iAmStar ? 'あなたが主役' : '主役のお題';
  setHtml($('#play-who'), `${avatarHtml(playerOf(target), 'sm')}<span>${who}</span>`);
  setText($('#play-question'), q.text);
  setText($('#play-opt-A-label'), q.optionA);
  setText($('#play-opt-B-label'), q.optionB);

  const card = $('#play-card');
  card.classList.toggle('is-drum', drumming);
  $('#play-answer').classList.toggle('is-open', revealed);
  KEYS.forEach((k) => {
    $(`#play-opt-${k}`).classList.toggle('is-answer', revealed && answer === k);
    $(`#play-opt-${k}`).classList.toggle('is-miss', revealed && KEYS.includes(answer) && answer !== k);
  });
  const front = $('#play-answer-front');
  if (KEYS.includes(answer)) {
    front.className = `answer-face answer-front is-${answer}`;
    setText($('#play-answer-suit'), `${SUITS[answer]}${answer}`);
    setText($('#play-answer-label'), answer === 'A' ? q.optionA : q.optionB);
  } else {
    front.className = 'answer-face answer-front is-void';
    setText($('#play-answer-suit'), '×');
    setText($('#play-answer-label'), '答えが選ばれなかったので無効');
  }

  // 自分の答え（自分にだけ見える）。1対1は自分のお題、複数人は自分が主役のとき
  const mine = $('#play-mine');
  const myQ = turn.questions[state.uid];
  if (myQ) {
    const myAnswer = G.answers[key]?.[state.uid];
    show(mine, true);
    mine.classList.toggle('is-same', iAmStar);
    setText($('.mine-head', mine).firstChild, iAmStar ? 'あなたの答え' : 'あなたのお題');
    setText($('.mine-head span', mine), G.kind === 'duel' ? '相手が賭けます' : 'みんなには秘密');
    setText($('#play-mine-question'), iAmStar ? '' : myQ.text);
    show($('#play-mine-question'), !iAmStar);
    setHtml($('#play-mine-answer'), KEYS.includes(myAnswer)
      ? `<span class="code-suit is-${myAnswer}">${SUITS[myAnswer]}</span>${escapeHtml(myAnswer === 'A' ? myQ.optionA : myQ.optionB)}<small>（相手には見えません）</small>`
      : '<small>答えを選んでください</small>');
  } else {
    show(mine, false);
  }
}

function renderTalk(G, turn) {
  const target = cardTargetOf(G, turn);
  const q = turn.questions[target];
  const iAmStar = target === state.uid;
  setHtml($('#talk-hints'), (q.hints || []).slice(0, 2).map((h) => `<li>${escapeHtml(h)}</li>`).join(''));
  show($('#talk-hints-box'), (q.hints || []).length > 0 && !iAmStar);
  let desc;
  if (G.kind === 'duel') {
    desc = 'あなたも質問されます。選択肢の言葉は使わずに、自分の言葉で答えてね。';
  } else if (iAmStar) {
    desc = 'あなたが主役。みんなの質問に、選択肢の言葉を使わずに答えよう。';
  } else {
    desc = `主役の${playerOf(target).nickname}さんに、遠回しな質問をぶつけよう。`;
  }
  setText($('#talk-desc'), desc);
}

function renderBet(G, turn, book) {
  const t = G.turnIndex;
  const key = tKey(t);
  if (state.sel.key !== `${G.gameId}:${key}`) {
    state.sel = {
      key: `${G.gameId}:${key}`, pick: null, stake: null, sent: null,
    };
  }
  const me = myBettorInfo(G, t);
  const form = $('#bet-form');
  const placed = $('#bet-placed');
  const watch = $('#bet-watch');

  // 複数人の主役：賭けない。みんなの BET の進み具合を見る
  if (!me) {
    show(form, false);
    show(placed, false);
    show(watch, true);
    const bettors = bettorsOf(G, t);
    const done = bettors.filter(({ bettor }) => G.bets[key]?.[bettor]).length;
    setText($('#bet-watch-title'), 'みんながあなたの答えに賭けています');
    setText($('#bet-watch-desc'), `${bettors.length}人中 ${done}人がBET済み`);
    return;
  }
  show(watch, false);
  const q = turn.questions[me.target];
  const available = book.before[state.uid] ?? 0;
  const bet = G.bets[key]?.[state.uid] || state.sel.sent;

  if (bet || available <= 0) {
    show(form, false);
    show(placed, true);
    if (bet) {
      setText($('#bet-placed-title'), 'BET済み');
      setHtml($('#bet-placed-detail'), `<span class="code-suit is-${bet.pick}">${SUITS[bet.pick]}</span>${escapeHtml(bet.pick === 'A' ? q.optionA : q.optionB)}に <strong>${formatCoins(bet.amount)}</strong> コイン`);
    } else {
      setText($('#bet-placed-title'), '見学');
      setText($('#bet-placed-detail'), 'コインがないので、このラウンドは賭けられません');
    }
    const waiting = bettorsOf(G, t).filter(({ bettor }) => !G.bets[key]?.[bettor] && (book.before[bettor] ?? 0) > 0);
    setText($('#bet-placed-wait'), waiting.length ? 'ほかの人のBETを待っています' : 'まもなくショーダウン');
    return;
  }
  show(form, true);
  show(placed, false);

  setText($('#bet-pick-A-label'), q.optionA);
  setText($('#bet-pick-B-label'), q.optionB);
  form.querySelectorAll('.bet-pick').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(state.sel.pick === btn.dataset.pick));
  });
  form.querySelectorAll('.chip').forEach((btn) => {
    const value = stakeValue(btn.dataset.stake, available);
    const ok = value > 0 && value <= available;
    btn.disabled = !ok;
    if (!ok && state.sel.stake === btn.dataset.stake) state.sel.stake = null;
    btn.setAttribute('aria-pressed', String(state.sel.stake === btn.dataset.stake));
  });
  const ready = KEYS.includes(state.sel.pick) && !!state.sel.stake;
  const busy = state.inflight.has(`bet:${state.sel.key}`);
  $('#bet-confirm').disabled = !ready || busy;
  const amount = ready ? stakeValue(state.sel.stake, available) : 0;
  setText($('#bet-confirm-sub'), ready
    ? `${SUITS[state.sel.pick]}${state.sel.pick === 'A' ? q.optionA : q.optionB}に ${formatCoins(amount)} コイン${state.sel.stake === 'all' ? '（ALL IN）' : ''}`
    : '答えと賭け金を選んでください');
}

function confirmBet() {
  const G = state.G;
  if (!G || G.phase !== 'bet') return;
  const t = G.turnIndex;
  const me = myBettorInfo(G, t);
  if (!me || !KEYS.includes(state.sel.pick) || !state.sel.stake) return;
  const available = ledger(G).before[state.uid] ?? 0;
  const amount = Math.min(available, stakeValue(state.sel.stake, available));
  if (amount <= 0) return;
  const bet = {
    target: me.target, pick: state.sel.pick, amount, allIn: state.sel.stake === 'all',
  };
  const selKey = state.sel.key;
  vibrate(state.sel.stake === 'all' ? [80, 40, 160] : 40);
  act(`bet:${selKey}`, async () => {
    await placeBet(state.uid, t, bet);
    if (state.sel.key === selKey) state.sel.sent = bet;
    render();
  }, true);
  render();
}

// ショーダウン：自分の当たり外れ（主役なら、何人に当てられたか）
function renderShowdown(G, turn, book, elapsed) {
  const t = G.turnIndex;
  const row = book.rows.find((r) => r.t === t);
  const results = row?.results || {};
  const drum = elapsed < DRUM_MS;
  const verdictOn = elapsed >= VERDICT_MS;
  show($('#showdown-drum'), drum);
  show($('#showdown-verdict'), verdictOn);
  const verdict = $('#showdown-verdict');
  const mine = results[state.uid];
  const me = myBettorInfo(G, t);
  let title = '';
  let detail = '';
  let tone = 'is-even';
  if (me) {
    if (!mine) {
      title = '賭けなかった';
      detail = 'コインはそのまま';
    } else if (mine.hit === null) {
      title = '無効';
      detail = '答えが選ばれなかったので、賭け金は戻ります';
    } else if (mine.hit) {
      title = '的中！';
      detail = `+${formatCoins(mine.amount)} コイン`;
      tone = 'is-win';
    } else {
      title = 'ハズレ…';
      detail = `−${formatCoins(mine.amount)} コイン`;
      tone = 'is-lose';
    }
  } else {
    const list = Object.values(results);
    const hits = list.filter((r) => r.hit).length;
    title = list.length ? `${list.length}人中 ${hits}人が的中` : '誰も賭けませんでした';
    detail = hits === 0 && list.length ? 'みんなの予想を裏切った！' : 'あなたの本音、見抜かれたかも';
    tone = hits === 0 ? 'is-win' : 'is-even';
  }
  verdict.className = `verdict ${tone}`;
  setText($('#verdict-title'), title);
  setText($('#verdict-detail'), detail);

  // 1対1：相手が自分のお題に賭けた結果も出す
  const sub = $('#showdown-sub');
  if (G.kind === 'duel' && verdictOn) {
    const oppId = G.playerIds.find((id) => id !== state.uid);
    const r = results[oppId];
    let text = `${playerOf(oppId).nickname}さんは、あなたのお題に賭けませんでした`;
    if (r && r.hit === null) text = `${playerOf(oppId).nickname}さんの賭けは無効`;
    else if (r) text = `${playerOf(oppId).nickname}さんはあなたのお題を${r.hit ? '的中' : 'ハズレ'}（${r.hit ? '+' : '−'}${formatCoins(r.amount)}）`;
    setText(sub, text);
    show(sub, true);
  } else {
    show(sub, false);
  }
}

function renderGap(G, turn, book) {
  const t = G.turnIndex;
  const row = book.rows.find((r) => r.t === t);
  const results = row?.results || {};
  const bettors = bettorsOf(G, t);
  const html = bettors.map(({ bettor, target }) => {
    const r = results[bettor];
    const q = turn.questions[target];
    if (!r) {
      const broke = (book.before[bettor] ?? 0) <= 0;
      return `
        <li class="bet-log-item">
          ${avatarHtml(playerOf(bettor), 'sm')}
          <span class="bet-log-body">
            <span class="bet-log-name">${escapeHtml(nameOf(bettor))}</span>
            <span class="bet-log-pick is-none">${broke ? 'コインがなく見学' : '賭けなかった'}</span>
          </span>
          <span class="bet-log-delta">±0</span>
        </li>`;
    }
    const label = r.pick === 'A' ? q.optionA : q.optionB;
    const deltaText = r.hit === null ? '±0' : `${r.delta > 0 ? '+' : '−'}${formatCoins(Math.abs(r.delta))}`;
    return `
      <li class="bet-log-item${r.hit ? ' is-hit' : r.hit === false ? ' is-miss' : ''}">
        ${avatarHtml(playerOf(bettor), 'sm')}
        <span class="bet-log-body">
          <span class="bet-log-name">${escapeHtml(nameOf(bettor))}${G.kind === 'duel' ? ` → ${escapeHtml(nameOf(target))}のお題` : ''}</span>
          <span class="bet-log-pick"><span class="code-suit is-${r.pick}">${SUITS[r.pick]}</span>${escapeHtml(label)}に${formatCoins(r.amount)}</span>
        </span>
        <span class="bet-log-delta">${deltaText}</span>
      </li>`;
  }).join('');
  setHtml($('#gap-bets'), html);

  const last = t + 1 >= G.totalTurns;
  let next = '次のラウンドへ';
  if (last) next = '最終結果へ';
  else if (G.kind === 'room') next = '次のラウンドへ（主役交代）';
  setText($('#gap-next'), next);
  show($('#gap-next'), G.driver);
  $('#gap-next').disabled = state.inflight.has(`start:${G.gameId}:${t + 1}`);
  show($('#gap-wait'), !G.driver);
  setText($('#gap-wait'), last ? 'ホストが最終結果へ進めます' : 'ホストが次のラウンドへ進めます');
  let desc = '予想と答えのギャップについて話そう。なぜそっちだと思った？';
  if (G.kind === 'room') {
    desc = turn.targets[0] === state.uid
      ? 'みんなの予想とのギャップについて話そう。どうしてそう見えたのか聞いてみて。'
      : `主役の${playerOf(turn.targets[0]).nickname}さんに、意外だったところを話そう。なぜそっちに賭けた？`;
  }
  setText($('#gap-desc'), desc);
}

function renderPlay(now = Date.now()) {
  const G = state.G;
  const key = tKey(G.turnIndex);
  const turn = G.turns[key];
  if (!turn) {
    showView('loading');
    return;
  }
  showView('play');
  const elapsed = G.phaseAt ? now - G.phaseAt : 0;
  const revealed = G.phase === 'gap' || (G.phase === 'showdown' && elapsed >= DRUM_MS);
  const drumming = G.phase === 'showdown' && elapsed < DRUM_MS;
  const book = ledger(G);
  // コインの増減は、当たり外れを出すタイミングで動かす
  const coinsRevealed = G.phase === 'gap' || (G.phase === 'showdown' && elapsed >= VERDICT_MS);

  // フェーズが変わった瞬間に短く振動
  const phaseKey = `${G.gameId}:${key}:${G.phase}`;
  if (state.phaseKey !== phaseKey) {
    const first = state.phaseKey === null;
    state.phaseKey = phaseKey;
    if (!first && (G.phase === 'talk' || G.phase === 'bet')) vibrate(G.phase === 'bet' ? [80, 50, 80] : 60);
  }
  // めくれた瞬間の振動（あとから開いたときは鳴らさない）
  if (revealed && state.revealedFor !== key && G.phase === 'showdown') {
    state.revealedFor = key;
    if (elapsed < DRUM_MS + 1500) vibrate([40, 30, 40, 30, 200]);
  }

  document.body.dataset.phase = G.phase;
  renderHead(G, now);
  renderBank(G, coinsRevealed, book);
  renderCard(G, turn, revealed, drumming);
  PHASES.forEach((p) => show($(`#phase-${p}`), p === G.phase));
  if (G.phase === 'setup') {
    setText($('#setup-desc'), myStanceTurn(G)
      ? 'あなたの答えを、こっそり選んでください。'
      : 'お題を読んだら、まもなく尋問タイム。答えはまだ伏せられています。');
  }
  if (G.phase === 'talk') renderTalk(G, turn);
  if (G.phase === 'bet') renderBet(G, turn, book);
  if (G.phase === 'showdown') renderShowdown(G, turn, book, elapsed);
  if (G.phase === 'gap') renderGap(G, turn, book);
}

/* ------------------------------------------------------------------ */
/* S36 最終結果                                                        */
/* ------------------------------------------------------------------ */

function renderFinal() {
  const G = state.G;
  const book = ledger(G);
  const ranked = [...G.playerIds].sort((a, b) => (book.coins[b] ?? 0) - (book.coins[a] ?? 0));
  const rankOf = (id) => 1 + ranked.filter((x) => (book.coins[x] ?? 0) > (book.coins[id] ?? 0)).length;
  const top = ranked.filter((id) => rankOf(id) === 1);
  const myRank = rankOf(state.uid);

  const stamp = $('#final-stamp');
  if (G.kind === 'duel') {
    const draw = top.length > 1;
    stamp.textContent = draw ? '分' : myRank === 1 ? '勝' : '負';
    stamp.className = `stamp${draw ? ' is-draw' : myRank === 1 ? '' : ' is-lose'}`;
  } else {
    stamp.textContent = `${myRank}位`;
    stamp.className = `stamp${myRank === 1 ? '' : ' is-lose'}`;
  }
  $('#final-title').textContent = top.length > 1
    ? `${top.map((id) => playerOf(id).nickname).join('・')} が同点`
    : `優勝 ${playerOf(top[0]).nickname}${top[0] === state.uid ? '（あなた）' : ''}`;
  $('#final-desc').textContent = `${formatCoins(book.coins[top[0]] ?? 0)} コインでフィニッシュ`;

  setHtml($('#final-ranking'), ranked.map((id) => {
    const rank = rankOf(id);
    const coins = book.coins[id] ?? 0;
    const diff = coins - BET_START_COINS;
    return `
      <li class="rank-item${rank === 1 ? ' is-top' : ''}${id === state.uid ? ' is-me' : ''}">
        <span class="rank-no">${rank}</span>
        ${avatarHtml(playerOf(id), 'sm')}
        <span class="rank-name">${escapeHtml(playerOf(id).nickname)}${id === state.uid ? '<small>あなた</small>' : ''}</span>
        <span class="rank-coins">${formatCoins(coins)}<small>${diff >= 0 ? '+' : '−'}${formatCoins(Math.abs(diff))}</small></span>
      </li>`;
  }).join(''));

  setHtml($('#final-history'), book.rows.map(({ t, results }) => {
    const turn = G.turns[tKey(t)];
    return turn.targets.map((target) => {
      const q = turn.questions[target];
      const answer = G.answers[tKey(t)]?.[target];
      const guesses = Object.values(results).filter((r) => r.target === target);
      const hits = guesses.filter((r) => r.hit).length;
      return `
        <li class="history-item">
          <span class="history-round">R${t + 1}</span>
          <span class="history-body">
            <span class="history-q">${escapeHtml(q.text)}</span>
            <span class="history-a">${KEYS.includes(answer) ? `<span class="code-suit is-${answer}">${SUITS[answer]}</span>${escapeHtml(answer === 'A' ? q.optionA : q.optionB)}` : '無効'}</span>
          </span>
          <span class="history-hit">${guesses.length ? `${hits}/${guesses.length} 的中` : '—'}</span>
        </li>`;
    }).join('');
  }).join(''));

  if (G.kind === 'duel') {
    show($('#final-actions'), true);
    show($('#final-retry'), true);
    show($('#final-wait'), false);
    $('#final-home').textContent = 'ホームへ';
  } else {
    show($('#final-actions'), G.driver);
    show($('#final-wait'), !G.driver);
    $('#final-home').textContent = 'ロビーへ戻る';
  }
  showView('final');
}

/* ------------------------------------------------------------------ */
/* 状態の変化                                                          */
/* ------------------------------------------------------------------ */

function render() {
  const G = state.G;
  if (state.kind === 'duel') {
    const duel = state.duel;
    if (!duel) return;
    if (duel.status === 'waiting') {
      renderWaiting();
      return;
    }
    if (duel.status === 'cancelled') {
      showView('cancelled');
      return;
    }
  }
  if (!G) {
    showView('loading');
    return;
  }
  if (G.status === 'finished') {
    show($('#stance'), false);
    renderFinal();
    return;
  }
  if (G.turnIndex < 0 || !G.phase) {
    showView('loading');
    return;
  }
  renderPlay();
}

function tick() {
  const G = state.G;
  if (!G || G.status !== 'playing') return;
  const now = Date.now();
  drive(G, now);
  bot.run(G, now);
  renderStance(G, now);
  if (G.turnIndex >= 0 && G.phase) renderPlay(now);
}

function onDuel(duel) {
  if (!duel) {
    showFatal(new Error('対戦が見つかりません。もう一度カードをタッチしてください。'));
    return;
  }
  if (!duel.playerIds.includes(state.uid)) {
    showFatal(new Error('この対戦には参加していません。'));
    return;
  }
  // ほかのモードの対戦は、その画面で開き直す
  if (duelModeOf(duel) !== 'bet') {
    location.replace(`${duelPage(duelModeOf(duel))}?duel=${encodeURIComponent(state.id)}`);
    return;
  }
  state.duel = duel;
  recompute();
  bot.onDuel(duel);
  render();
}

function onRoom(room) {
  if (state.leaving) return;
  if (!room || room.status === 'finished' || !room.memberIds.includes(state.uid)) {
    toast('このルームは終了しました');
    location.replace('lobby.html');
    return;
  }
  // ホストがロビーに戻した（または別のモードを選んだ）
  if (room.status !== 'playing' || room.mode !== 'profileBet') {
    state.leaving = true;
    location.replace(`lobby.html?room=${encodeURIComponent(room.id)}`);
    return;
  }
  state.room = room;
  recompute();
  if (!room.bet && room.hostId === state.uid && state.members.length) {
    createRoomGame().catch((err) => toast(errorMessage(err), 'error'));
  }
  render();
}

/* ------------------------------------------------------------------ */
/* ローカルモード専用：テスト相手（ボット）の動き                        */
/* ------------------------------------------------------------------ */

const bot = {
  timers: [],
  // ボットごとの考える時間（ベットが始まってから賭けるまで）
  delayOf(id) {
    const n = Array.from(id).reduce((s, c) => s + c.charCodeAt(0), 0);
    return 2000 + (n % 6) * 900;
  },
  onDuel(duel) {
    if (!isLocalMode || !state.opponent?.isDummy) return;
    const botId = duel.playerIds.find((id) => id !== state.uid);
    // もう一度の申し込みにはすぐ応じる
    if (duel.status === 'waiting' && !duel.joined?.[botId]) {
      this.timers.push(setTimeout(() => store.updateDuel(state.id, (d) => (d.status === 'waiting'
        ? { joined: { ...d.joined, [botId]: true }, status: 'playing', startedAt: Date.now() }
        : null)), 800));
    }
  },
  run(G, now) {
    if (!isLocalMode || G.status !== 'playing' || G.turnIndex < 0 || !G.phaseAt) return;
    const t = G.turnIndex;
    const key = tKey(t);
    const turn = G.turns[key];
    if (!turn) return;
    const elapsed = now - G.phaseAt;
    G.playerIds.filter((id) => G.players[id]?.isDummy).forEach((id) => {
      // 主役で答えがないお題：すぐにこっそり選ぶ
      if (G.phase === 'setup' && elapsed > 1500 && turn.targets.includes(id)
        && turn.needsStance?.[id] && !G.answers[key]?.[id]) {
        act(`bot-stance:${G.gameId}:${key}:${id}`, () => setStance(id, t, KEYS[Math.floor(Math.random() * 2)]));
      }
      // ベット：少し考えてから、ランダムな答えと賭け金で
      if (G.phase === 'bet' && elapsed > this.delayOf(id) && !G.bets[key]?.[id]) {
        const info = bettorsOf(G, t).find((b) => b.bettor === id);
        const available = ledger(G).before[id] ?? 0;
        if (!info || available <= 0) return;
        // たまに ALL IN（持ちコインが少ないときは全部）
        const stakes = BET_STAKES.filter((s) => s <= available);
        const allIn = !stakes.length || Math.random() < 0.15;
        const amount = allIn ? available : stakes[Math.floor(Math.random() * stakes.length)];
        act(`bot-bet:${G.gameId}:${key}:${id}`, () => placeBet(id, t, {
          target: info.target,
          pick: KEYS[Math.floor(Math.random() * 2)],
          amount,
          allIn: amount === available,
        }));
      }
    });
  },
};

/* ------------------------------------------------------------------ */
/* 起動                                                                */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $('#bet-form').addEventListener('click', (e) => {
    const pick = e.target.closest('.bet-pick');
    const chip = e.target.closest('.chip');
    if (pick) {
      state.sel.pick = pick.dataset.pick;
      vibrate(20);
    } else if (chip && !chip.disabled) {
      state.sel.stake = chip.dataset.stake;
      vibrate(chip.dataset.stake === 'all' ? [30, 30, 60] : 20);
    } else {
      return;
    }
    render();
  });
  $('#bet-confirm').addEventListener('click', confirmBet);

  $('#stance').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-stance]');
    if (btn) chooseStance(btn.dataset.stance);
  });

  $('#gap-next').addEventListener('click', nextRound);

  $('#final-retry').addEventListener('click', async () => {
    if (state.kind === 'duel') {
      const oppId = state.duel.playerIds.find((id) => id !== state.uid);
      try {
        await store.enterDuel(state.uid, oppId, state.me, 'bet');
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
      return;
    }
    createRoomGame(true).catch((err) => toast(errorMessage(err), 'error'));
  });
  $('#final-home').addEventListener('click', async (e) => {
    if (state.kind !== 'room') return;
    e.preventDefault();
    try {
      await store.updateRoom(state.id, (r) => (r.hostId === state.uid
        ? { status: 'lobby', mode: null, bet: null }
        : null));
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  if (state.kind === 'duel') {
    const rejoin = async () => {
      const oppId = state.duel.playerIds.find((id) => id !== state.uid);
      try {
        await store.enterDuel(state.uid, oppId, state.me, 'bet');
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    };
    $('#wait-accept').addEventListener('click', rejoin);
    $('#cancelled-retry').addEventListener('click', rejoin);
    const cancel = async () => {
      try {
        await store.updateDuel(state.id, (d) => (d.status === 'waiting' ? { status: 'cancelled' } : null));
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    };
    $('#wait-cancel').addEventListener('click', cancel);
    $('#wait-decline').addEventListener('click', cancel);
  }
}

async function startDuel() {
  state.kind = 'duel';
  const opponentId = params.get('opponent');
  if (opponentId) {
    if (opponentId === state.uid) {
      location.replace('lobby.html');
      return;
    }
    state.id = await store.enterDuel(state.uid, opponentId, state.me, 'bet');
    history.replaceState(null, '', `bet.html?duel=${encodeURIComponent(state.id)}`);
  } else {
    state.id = params.get('duel');
  }
  if (!state.id) {
    location.replace('lobby.html');
    return;
  }
  const duel = await store.getDuel(state.id);
  const oppId = duel?.playerIds?.find((id) => id !== state.uid);
  if (oppId) state.opponent = await store.getPlayer(oppId);

  bindEvents();
  await store.watchDuel(state.id, (d, err) => {
    if (err) {
      showFatal(err);
      return;
    }
    onDuel(d);
  });
}

async function startRoom(roomId) {
  state.kind = 'room';
  state.id = roomId;
  const room = await store.getRoom(roomId);
  if (!room || room.status === 'finished' || !room.memberIds.includes(state.uid)) {
    toast('このルームには入室していません');
    location.replace('lobby.html');
    return;
  }
  bindEvents();
  await store.watchMembers(roomId, (members) => {
    state.members = members;
    if (state.room) onRoom(state.room);
  });
  await store.watchRoom(roomId, onRoom);

  const beat = () => store.heartbeat(roomId, state.uid).catch(console.warn);
  beat();
  setInterval(beat, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') beat();
  });
}

async function main() {
  showLocalBanner();
  state.uid = await signIn();
  state.me = await store.getPlayer(state.uid);
  if (!state.me?.nickname) {
    location.replace(`profile.html?next=${encodeURIComponent(`bet.html${location.search}`)}`);
    return;
  }
  const roomId = params.get('room');
  if (roomId) await startRoom(roomId);
  else await startDuel();
  setInterval(tick, TICK_MS);
}

main().catch(showFatal);
