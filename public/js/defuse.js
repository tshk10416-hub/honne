// D10 マッチング / D11 解除コードの準備 / D12 時限爆弾解除（60秒） / D13 結果
//   defuse.html?opponent=<uid>  モード選択で「時限爆弾解除」を選んだとき（対戦に参加して ?duel= に置き換える）
//   defuse.html?duel=<duelId>   挑戦の受諾・再読み込み・もう一度
//
// 流れ：2人そろう → 準備（arming：自分の解除コード2問を決めて「準備OK」）
//       → 2人とも準備OKで起爆（live：3秒のカウントダウンのあと60秒）→ 結果
//   自分の画面には「相手の」解除コードの問題が出る。相手に質問して答えを聞き出し、A／Bで入力して解除。
//   2人とも正しく解除できたら MISSION COMPLETE。1人でも間違えるか、時間切れで GAME OVER。
//   解除コードの答え（keys）は対戦ドキュメントに入る。アンケートの回答と同じく、画面には出さないだけの扱い。
import { signIn, isLocalMode } from './firebase.js';
import {
  store, toMillis, duelModeOf, duelPage, SERVER_TIME,
  DEFUSE_SECONDS, DEFUSE_DIGITS, DEFUSE_COUNTDOWN_MS,
} from './store.js';
import { pickDefuseCode } from './topics.js';
import {
  $, avatarHtml, escapeHtml, show, toast, errorMessage, showFatal, showLocalBanner,
} from './ui.js';

const params = new URLSearchParams(location.search);
const CRITICAL_SECONDS = 10;
const KEYS = ['A', 'B'];
const SUITS = { A: '♥', B: '♠' };

const state = {
  uid: null,
  me: null,
  duelId: null,
  duel: null,
  opponentId: null,
  opponent: null,
  inputs: [], // 解除パネルで選んだ A/B（ラウンドごとに作り直す）
  inputsRound: null,
  coding: false, // 解除コードを作成中
  busy: false,
  exploding: null, // 時間切れの処理中のラウンド
  lastSecond: null, // 残り10秒の振動を1秒に1回にする
  startedFor: null, // 起爆の振動を鳴らしたラウンド
  endedFor: null, // 結果の演出を出したラウンド
  frame: null,
};

/* ------------------------------------------------------------------ */
/* 共通                                                                */
/* ------------------------------------------------------------------ */

const VIEWS = ['loading', 'waiting', 'arming', 'live', 'result', 'cancelled'];
function showView(name) {
  VIEWS.forEach((v) => show($(`#view-${v}`), v === name));
  document.body.classList.toggle('is-live', name === 'live');
}

function nameOf(id) {
  return state.duel?.players?.[id]?.nickname || '相手';
}
function playerOf(id) {
  return state.duel?.players?.[id] || { nickname: '？' };
}

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// 起爆の合図（liveAt）から3秒後にタイマーが動き出す
function liveStartsAt(duel) {
  const at = toMillis(duel.liveAt);
  return at ? at + DEFUSE_COUNTDOWN_MS : 0;
}
function liveEndsAt(duel) {
  const start = liveStartsAt(duel);
  return start ? start + (duel.timeSec || DEFUSE_SECONDS) * 1000 : 0;
}

function formatTimer(ms) {
  const cs = Math.max(0, Math.ceil(ms / 10));
  const sec = Math.floor(cs / 100);
  return `${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

// 1文字ずつ同じ幅の箱に入れて、数字が変わっても桁がぶれないようにする
function timerHtml(text) {
  return Array.from(text).map((c) => `<span class="${c === '.' ? 'tdot' : 'tdigit'}">${c}</span>`).join('');
}

function codesOf(id) {
  return state.duel?.codes?.[id] || [];
}
function keysOf(id) {
  return state.duel?.keys?.[id] || [];
}

/* ------------------------------------------------------------------ */
/* D10 マッチング                                                      */
/* ------------------------------------------------------------------ */

function versusHtml(id, label, ready) {
  return `
    ${avatarHtml(playerOf(id), 'lg')}
    <span class="versus-name">${escapeHtml(playerOf(id).nickname)}</span>
    <span class="versus-state${ready ? ' is-ready' : ''}">${label}</span>`;
}

function renderWaiting() {
  const { duel, uid, opponentId } = state;
  const meJoined = !!duel.joined?.[uid];
  const oppJoined = !!duel.joined?.[opponentId];
  $('#wait-me').innerHTML = versusHtml(uid, meJoined ? '準備OK' : '未参加', meJoined);
  $('#wait-opp').innerHTML = versusHtml(opponentId, oppJoined ? '準備OK' : '参加待ち', oppJoined);
  show($('#wait-pending'), meJoined);
  show($('#wait-invite'), !meJoined);
  $('#wait-pending-text').textContent = `${nameOf(opponentId)}さんの参加を待っています`;
  $('#wait-invite-text').textContent = duel.round > 1
    ? `${nameOf(opponentId)}さんから「時限爆弾解除」の再挑戦です`
    : `${nameOf(opponentId)}さんから「時限爆弾解除」の挑戦が届いています`;
  $('#rules-sec').textContent = duel.timeSec || DEFUSE_SECONDS;
  showView('waiting');
}

/* ------------------------------------------------------------------ */
/* D11 解除コードの準備                                                */
/* ------------------------------------------------------------------ */

// 自分の解除コード（相手が当てる問題）がまだなければ作る。
// アンケートが足りない分は直感クイズになり、答えは準備画面で本人が選ぶ。
async function ensureMyCode() {
  const { duel, uid } = state;
  if (duel.codes?.[uid] || state.coding) return;
  state.coding = true;
  try {
    const me = await store.getPlayer(uid);
    const { codes, keys } = pickDefuseCode(me, DEFUSE_DIGITS);
    await store.updateDuel(state.duelId, (d) => (d.round === duel.round && d.status === 'playing'
      && d.phase === 'arming' && !d.codes?.[uid]
      ? { codes: { ...d.codes, [uid]: codes }, keys: { ...d.keys, [uid]: keys } }
      : null));
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    state.coding = false;
  }
}

function codeReady(id) {
  const codes = codesOf(id);
  const keys = keysOf(id);
  return codes.length > 0 && codes.every((_, i) => KEYS.includes(keys[i]));
}

function renderArming() {
  const { duel, uid, opponentId } = state;
  const codes = codesOf(uid);
  const keys = keysOf(uid);
  const armed = !!duel.armed?.[uid];
  const needsQuiz = codes.some((c) => c.source === 'quiz');

  $('#arm-desc').textContent = needsQuiz
    ? 'アンケートの回答が足りない分は、直感クイズになりました。いまの気分で答えを選んでください。その答えが、相手が当てる解除コードになります。'
    : `この${codes.length || DEFUSE_DIGITS}問の答えが、あなたの解除コードです。${nameOf(opponentId)}さんがあなたに質問して、答えを当てにきます。正直に答えてね。`;

  if (!codes.length) {
    $('#arm-codes').innerHTML = '<li class="code-item"><div class="waiting"><div class="spinner" aria-hidden="true"></div>コードを作っています</div></li>';
  } else {
    $('#arm-codes').innerHTML = codes.map((c, i) => {
      const key = keys[i];
      const body = c.source === 'quiz' && !armed
        ? `<div class="mini-choices" role="group" aria-label="${escapeHtml(c.text)}">
            ${KEYS.map((k) => `
              <button type="button" class="mini-choice" data-index="${i}" data-key="${k}" aria-pressed="${key === k}">
                <span class="mini-choice-key">${SUITS[k]}</span>${escapeHtml(c.options[k])}
              </button>`).join('')}
          </div>`
        : `<p class="code-answer">${key ? `<span class="code-suit is-${key}">${SUITS[key]}</span>${escapeHtml(c.options[key])}` : '未回答'}</p>`;
      return `
        <li class="code-item">
          <p class="code-q"><span class="code-no">${i + 1}</span>${escapeHtml(c.text)}</p>
          ${body}
          <p class="code-source">${c.source === 'quiz' ? '直感クイズ' : 'あなたのアンケートから'}</p>
        </li>`;
    }).join('');
  }

  const armHtml = (id, label) => {
    const ready = !!duel.armed?.[id];
    return `${avatarHtml(playerOf(id), 'sm')}
      <span class="arm-name">${escapeHtml(label)}</span>
      <span class="arm-state${ready ? ' is-ready' : ''}">${ready ? '準備OK' : '準備中'}</span>`;
  };
  $('#arm-me').innerHTML = armHtml(uid, 'あなた');
  $('#arm-opp').innerHTML = armHtml(opponentId, `${nameOf(opponentId)}さん`);

  $('#arm-ready').disabled = !codeReady(uid) || state.busy;
  show($('#arm-ready'), !armed);
  show($('#arm-wait'), armed);
  $('#arm-wait-text').textContent = `${nameOf(opponentId)}さんの準備を待っています`;
  showView('arming');
}

async function chooseQuizAnswer(index, key) {
  const { uid } = state;
  const { round } = state.duel;
  try {
    await store.updateDuel(state.duelId, (d) => {
      if (d.round !== round || d.status !== 'playing' || d.phase !== 'arming' || d.armed?.[uid]) return null;
      const keys = [...(d.keys?.[uid] || [])];
      if (d.codes?.[uid]?.[index]?.source !== 'quiz') return null;
      keys[index] = key;
      return { keys: { ...d.keys, [uid]: keys } };
    });
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

// 準備OK。2人そろったら起爆（liveAt にサーバー時刻を入れ、両方の端末で同じ時刻から数える）
async function arm() {
  if (state.busy || !codeReady(state.uid)) return;
  state.busy = true;
  const { uid } = state;
  const { round } = state.duel;
  try {
    await store.updateDuel(state.duelId, (d) => {
      if (d.round !== round || d.status !== 'playing' || d.phase !== 'arming' || d.armed?.[uid]) return null;
      const armed = { ...d.armed, [uid]: true };
      const all = d.playerIds.every((id) => armed[id]);
      return all ? { armed, phase: 'live', liveAt: SERVER_TIME } : { armed };
    });
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    state.busy = false;
    if (state.duel?.phase === 'arming') renderArming();
  }
}

/* ------------------------------------------------------------------ */
/* D12 解除（60秒）                                                    */
/* ------------------------------------------------------------------ */

function resetInputs() {
  if (state.inputsRound === state.duel.round) return;
  state.inputsRound = state.duel.round;
  state.inputs = codesOf(state.opponentId).map(() => null);
}

function renderPanels() {
  const { opponentId, uid, duel } = state;
  const done = !!duel.defused?.[uid];
  // 起爆のカウントダウン中は押せない
  const locked = done || duel.status !== 'playing' || Date.now() < liveStartsAt(duel);
  const codes = codesOf(opponentId);
  $('#live-panels').innerHTML = codes.map((c, i) => `
    <div class="panel${state.inputs[i] ? ' is-set' : ''}">
      <p class="panel-head"><span class="panel-no">コード${i + 1}</span><span class="panel-topic">${escapeHtml(c.topic)}</span></p>
      <p class="panel-q">${escapeHtml(c.text)}</p>
      <div class="panel-keys" role="group" aria-label="コード${i + 1}">
        ${KEYS.map((k) => `
          <button type="button" class="key-btn is-${k}" data-index="${i}" data-key="${k}"
                  aria-pressed="${state.inputs[i] === k}" ${locked ? 'disabled' : ''}>
            <span class="key-btn-mark">${SUITS[k]}${k}</span>
            <span class="key-btn-label">${escapeHtml(c.options[k])}</span>
          </button>`).join('')}
      </div>
    </div>`).join('');
  renderDefuseButton();
}

function renderDefuseButton() {
  const { duel, uid } = state;
  const done = !!duel.defused?.[uid];
  const filled = state.inputs.length > 0 && state.inputs.every((v) => KEYS.includes(v));
  const btn = $('#live-defuse');
  btn.disabled = done || !filled || state.busy || Date.now() < liveStartsAt(duel);
  show(btn, !done);
  $('#live-defuse-sub').textContent = filled ? '押したら取り消せません' : `${state.inputs.length}つとも選ぶと押せます`;
}

function renderLive() {
  const { duel, uid, opponentId } = state;
  resetInputs();
  const done = !!duel.defused?.[uid];
  const oppDone = !!duel.defused?.[opponentId];
  showView('live');
  renderPanels();
  show($('#live-done'), done);
  $('#live-done-desc').textContent = oppDone
    ? 'まもなく完了します'
    : `${nameOf(opponentId)}さんがまだ解除中です。質問にすばやく答えて、手伝ってあげて！`;
  $('#live-order').textContent = done ? '相手の解除を手伝え' : '相手の解除コードを特定せよ';
  $('#live-partner').innerHTML = `${avatarHtml(playerOf(opponentId), 'sm')}
    <span>${escapeHtml(nameOf(opponentId))}さん：${oppDone ? '<strong class="is-ok">解除済み</strong>' : '解析中'}</span>`;
  startTicker();
}

async function defuse() {
  const { duel, uid, opponentId } = state;
  if (state.busy || duel.defused?.[uid]) return;
  const inputs = [...state.inputs];
  if (!inputs.every((v) => KEYS.includes(v))) return;
  state.busy = true;
  renderDefuseButton();
  const { round } = duel;
  const endsAt = liveEndsAt(duel);
  try {
    await store.updateDuel(state.duelId, (d) => {
      if (d.round !== round || d.status !== 'playing' || d.phase !== 'live' || d.defused?.[uid]) return null;
      const now = Date.now();
      const allInputs = { ...d.inputs, [uid]: inputs };
      if (now >= endsAt) {
        return { status: 'finished', outcome: 'exploded', reason: 'timeout', inputs: allInputs };
      }
      const keys = d.keys?.[opponentId] || [];
      const correct = keys.length === inputs.length && keys.every((k, i) => k === inputs[i]);
      if (!correct) {
        return {
          status: 'finished', outcome: 'exploded', reason: 'wrong', failedBy: uid, inputs: allInputs,
        };
      }
      const defused = { ...d.defused, [uid]: true };
      const all = d.playerIds.every((id) => defused[id]);
      return all
        ? {
          defused, inputs: allInputs, status: 'finished', outcome: 'complete', clearMs: Math.max(0, endsAt - now),
        }
        : { defused, inputs: allInputs };
    });
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    state.busy = false;
    if (state.duel?.status === 'playing') renderDefuseButton();
  }
}

// 時間切れ：最初に気付いた端末が爆発させる
async function explodeByTimeout() {
  const { round } = state.duel;
  if (state.exploding === round) return;
  state.exploding = round;
  try {
    await store.updateDuel(state.duelId, (d) => (d.round === round && d.status === 'playing' && d.phase === 'live'
      ? { status: 'finished', outcome: 'exploded', reason: 'timeout' }
      : null));
  } catch (err) {
    console.warn(err);
    state.exploding = null;
  }
}

// タイマー：requestAnimationFrame で 1/100 秒まで表示する
function startTicker() {
  if (state.frame) return;
  const tick = () => {
    state.frame = requestAnimationFrame(tick);
    const { duel } = state;
    if (!duel || duel.status !== 'playing' || duel.phase !== 'live') {
      stopTicker();
      return;
    }
    const now = Date.now();
    const start = liveStartsAt(duel);
    const total = (duel.timeSec || DEFUSE_SECONDS) * 1000;

    // 起爆前のカウントダウン
    const before = start - now;
    show($('#countdown'), before > 0);
    if (before > 0) {
      $('#countdown-num').textContent = Math.ceil(before / 1000);
      $('#live-timer').innerHTML = timerHtml(formatTimer(total));
      $('#live-fuse').style.transform = 'scaleX(1)';
      return;
    }
    if (state.startedFor !== duel.round) {
      state.startedFor = duel.round;
      // 起爆の瞬間：激しく振動（途中から開き直したときは鳴らさない）
      if (now - start < 2000) vibrate([400, 100, 400, 100, 800]);
      renderPanels();
    }

    const left = liveEndsAt(duel) - now;
    $('#live-timer').innerHTML = timerHtml(formatTimer(left));
    $('#live-fuse').style.transform = `scaleX(${Math.max(0, left / total)})`;
    const critical = left <= CRITICAL_SECONDS * 1000;
    document.body.classList.toggle('is-critical', critical);
    // 残り10秒からは、警告音のような短い振動を1秒ごとに
    const sec = Math.ceil(left / 1000);
    if (critical && left > 0 && state.lastSecond !== sec) {
      state.lastSecond = sec;
      vibrate([120, 60, 120, 60, 120]);
    }
    if (left <= 0) explodeByTimeout();
  };
  state.frame = requestAnimationFrame(tick);
}

function stopTicker() {
  if (state.frame) cancelAnimationFrame(state.frame);
  state.frame = null;
  show($('#countdown'), false);
  document.body.classList.remove('is-critical');
}

/* ------------------------------------------------------------------ */
/* D13 結果                                                            */
/* ------------------------------------------------------------------ */

// owner の解除コードを、guesser の入力と並べて表示
function answerItemsHtml(ownerId, guesserId) {
  const { duel } = state;
  const codes = codesOf(ownerId);
  const keys = keysOf(ownerId);
  const inputs = duel.inputs?.[guesserId] || [];
  if (!codes.length) return '<li class="answer-empty">コードはありませんでした</li>';
  return codes.map((c, i) => {
    const key = keys[i];
    const input = inputs[i];
    let mark = '<span class="badge">未入力</span>';
    let wrong = '';
    if (input === key) {
      mark = '<span class="badge badge-ok">正解</span>';
    } else if (input) {
      mark = '<span class="badge badge-ng">不正解</span>';
      wrong = `<span class="answer-input">入力：${escapeHtml(c.options[input])}</span>`;
    }
    return `
      <li class="answer-item">
        <span class="answer-body">
          <span class="answer-q">${escapeHtml(c.text)}</span>
          <span class="answer-a">${key ? `<span class="code-suit is-${key}">${SUITS[key]}</span>${escapeHtml(c.options[key])}` : '—'}</span>
          ${wrong}
        </span>
        ${mark}
      </li>`;
  }).join('');
}

function renderResult() {
  stopTicker();
  const { duel, uid, opponentId } = state;
  const complete = duel.outcome === 'complete';
  const stamp = $('#result-stamp');
  stamp.textContent = complete ? '解除' : '爆発';
  stamp.className = complete ? 'stamp' : 'stamp is-lose';
  $('#result-title').textContent = complete ? 'MISSION COMPLETE' : 'GAME OVER';
  $('#result-title').classList.toggle('is-over', !complete);
  if (complete) {
    $('#result-desc').textContent = `残り ${formatTimer(duel.clearMs || 0)} 秒で、2人とも解除に成功！`;
  } else if (duel.reason === 'wrong') {
    $('#result-desc').textContent = duel.failedBy === uid
      ? 'あなたの入力したコードが違っていました。'
      : `${nameOf(duel.failedBy)}さんの入力したコードが違っていました。`;
  } else {
    $('#result-desc').textContent = '時間切れ。爆弾が爆発しました。';
  }
  show($('#result-penalty'), !complete);
  $('#result-mine').innerHTML = answerItemsHtml(opponentId, uid);
  $('#result-opp-label').textContent = `${nameOf(opponentId)}さんが当てるコード（あなたの答え）`;
  $('#result-opp').innerHTML = answerItemsHtml(uid, opponentId);
  showView('result');

  // 終わった瞬間を見ていた端末だけ演出する（あとから開いたときは出さない）
  if (state.endedFor !== duel.round) {
    state.endedFor = duel.round;
    const justNow = Date.now() - toMillis(duel.updatedAt) < 5000;
    if (justNow && !complete) {
      vibrate([600, 100, 600, 100, 1000]);
      show($('#boom'), true);
      setTimeout(() => show($('#boom'), false), 1600);
    } else if (justNow) {
      vibrate([80, 60, 80, 60, 240]);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 状態の変化                                                          */
/* ------------------------------------------------------------------ */

async function onDuel(duel) {
  if (!duel) {
    showFatal(new Error('対戦が見つかりません。もう一度カードをタッチしてください。'));
    return;
  }
  if (!duel.playerIds.includes(state.uid)) {
    showFatal(new Error('この対戦には参加していません。'));
    return;
  }
  // ワード・スナイパーの対戦は、その画面で開き直す
  if (duelModeOf(duel) !== 'defuse') {
    location.replace(`${duelPage(duelModeOf(duel))}?duel=${encodeURIComponent(state.duelId)}`);
    return;
  }
  state.duel = duel;
  state.opponentId = duel.playerIds.find((id) => id !== state.uid);
  if (!state.opponent || state.opponent.id !== state.opponentId) {
    state.opponent = await store.getPlayer(state.opponentId);
  }

  switch (duel.status) {
    case 'waiting':
      stopTicker();
      renderWaiting();
      break;
    case 'playing':
      if (duel.phase === 'live') {
        renderLive();
      } else {
        stopTicker();
        renderArming();
        ensureMyCode();
      }
      break;
    case 'finished':
      renderResult();
      break;
    default:
      stopTicker();
      showView('cancelled');
  }
  bot.onDuel(duel);
}

/* ------------------------------------------------------------------ */
/* ローカルモード専用：テスト相手（ボット）の動き                        */
/* ------------------------------------------------------------------ */

const bot = {
  timers: [],
  key: null,
  get active() {
    return isLocalMode && state.opponent?.isDummy;
  },
  later(ms, fn) {
    this.timers.push(setTimeout(fn, ms));
  },
  clear() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  },
  onDuel(duel) {
    if (!this.active) return;
    const botId = state.opponentId;

    // もう一度の申し込みにはすぐ応じる
    if (duel.status === 'waiting' && !duel.joined?.[botId]) {
      this.later(800, () => store.updateDuel(state.duelId, (d) => (d.status === 'waiting'
        ? { joined: { ...d.joined, [botId]: true }, status: 'playing', startedAt: Date.now() }
        : null)));
      return;
    }
    if (duel.status !== 'playing') {
      this.clear();
      return;
    }

    const key = `${duel.round}:${duel.phase}`;
    if (this.key === key) return;
    this.key = key;
    this.clear();
    const { round } = duel;

    // 準備：コードを作って（クイズはランダムに回答）すぐ準備OK
    if (duel.phase === 'arming') {
      this.later(1200, () => store.updateDuel(state.duelId, (d) => {
        if (d.round !== round || d.phase !== 'arming' || d.armed?.[botId]) return null;
        const made = pickDefuseCode(state.opponent, DEFUSE_DIGITS);
        const keys = made.keys.map((k) => k || KEYS[Math.floor(Math.random() * 2)]);
        const armed = { ...d.armed, [botId]: true };
        const all = d.playerIds.every((id) => armed[id]);
        return {
          codes: { ...d.codes, [botId]: made.codes },
          keys: { ...d.keys, [botId]: keys },
          armed,
          ...(all ? { phase: 'live', liveAt: Date.now() } : {}),
        };
      }));
    }

    // 本番：しばらくしたら正しいコードで解除する
    if (duel.phase === 'live') {
      const wait = Math.max(0, liveStartsAt(duel) - Date.now()) + 15000 + Math.random() * 15000;
      this.later(wait, () => store.updateDuel(state.duelId, (d) => {
        if (d.round !== round || d.status !== 'playing' || d.phase !== 'live' || d.defused?.[botId]) return null;
        const defused = { ...d.defused, [botId]: true };
        const inputs = { ...d.inputs, [botId]: [...(d.keys?.[state.uid] || [])] };
        const all = d.playerIds.every((id) => defused[id]);
        return all
          ? {
            defused, inputs, status: 'finished', outcome: 'complete', clearMs: Math.max(0, liveEndsAt(d) - Date.now()),
          }
          : { defused, inputs };
      }));
    }
  },
};

/* ------------------------------------------------------------------ */
/* 起動                                                                */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $('#arm-codes').addEventListener('click', (e) => {
    const btn = e.target.closest('.mini-choice');
    if (!btn) return;
    chooseQuizAnswer(Number(btn.dataset.index), btn.dataset.key);
  });
  $('#arm-ready').addEventListener('click', arm);

  $('#live-panels').addEventListener('click', (e) => {
    const btn = e.target.closest('.key-btn');
    if (!btn || btn.disabled) return;
    const i = Number(btn.dataset.index);
    state.inputs[i] = btn.dataset.key;
    vibrate(30);
    renderPanels();
  });
  $('#live-defuse').addEventListener('click', defuse);

  const rejoin = async () => {
    try {
      await store.enterDuel(state.uid, state.opponentId, state.me, 'defuse');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  $('#wait-accept').addEventListener('click', rejoin);
  $('#result-retry').addEventListener('click', rejoin);
  $('#cancelled-retry').addEventListener('click', rejoin);

  const cancel = async () => {
    try {
      await store.updateDuel(state.duelId, (d) => (d.status === 'waiting'
        || (d.status === 'playing' && d.phase === 'arming')
        ? { status: 'cancelled' }
        : null));
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  $('#wait-cancel').addEventListener('click', cancel);
  $('#wait-decline').addEventListener('click', cancel);
  $('#arm-cancel').addEventListener('click', () => {
    if (window.confirm('爆弾解除をやめますか？')) cancel();
  });
}

async function main() {
  showLocalBanner();
  state.uid = await signIn();
  state.me = await store.getPlayer(state.uid);
  if (!state.me?.nickname) {
    location.replace(`profile.html?next=${encodeURIComponent(`index.html${location.search}`)}`);
    return;
  }

  const opponentId = params.get('opponent');
  if (opponentId) {
    if (opponentId === state.uid) {
      location.replace('lobby.html');
      return;
    }
    state.duelId = await store.enterDuel(state.uid, opponentId, state.me, 'defuse');
    history.replaceState(null, '', `defuse.html?duel=${encodeURIComponent(state.duelId)}`);
  } else {
    state.duelId = params.get('duel');
  }
  if (!state.duelId) {
    location.replace('lobby.html');
    return;
  }

  bindEvents();
  await store.watchDuel(state.duelId, (duel, err) => {
    if (err) {
      showFatal(err);
      return;
    }
    onDuel(duel).catch(console.error);
  });
}

main().catch(showFatal);
