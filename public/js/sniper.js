// S10 マッチング / S11 ワード・スナイパー対戦 / S12 結果
//   sniper.html?opponent=<uid>  相手の個人カードをタッチしたとき（対戦に参加して ?duel= に置き換える）
//   sniper.html?duel=<duelId>   挑戦の受諾・再読み込み・再戦
import { signIn, isLocalMode } from './firebase.js';
import { store, toMillis } from './store.js';
import { pickSniperWord, answeredQuestions } from './topics.js';
import {
  $, avatarHtml, escapeHtml, show, toast, errorMessage, showFatal, showLocalBanner,
} from './ui.js';

const params = new URLSearchParams(location.search);
const HURRY_SECONDS = 20;

const state = {
  uid: null,
  me: null,
  duelId: null,
  duel: null,
  opponentId: null,
  opponent: null, // 相手の players ドキュメント（ワード抽選に使う）
  secret: null, // 自分のターゲットワード
  secretTask: null,
  wordVisible: false,
  finishing: false,
  revealing: false,
  shownStartFor: null,
  busy: false,
};

/* ------------------------------------------------------------------ */
/* 表示の切り替え                                                      */
/* ------------------------------------------------------------------ */

const VIEWS = ['loading', 'waiting', 'playing', 'result', 'cancelled'];
function showView(name) {
  VIEWS.forEach((v) => show($(`#view-${v}`), v === name));
}

function openModal(id) {
  show($(`#${id}`), true);
}
function closeModal(id) {
  show($(`#${id}`), false);
}

function nameOf(id) {
  return state.duel?.players?.[id]?.nickname || '相手';
}
function playerOf(id) {
  return state.duel?.players?.[id] || { nickname: '？' };
}

function endsAt(duel) {
  const started = toMillis(duel.startedAt);
  return started ? started + duel.durationSec * 1000 : 0;
}

function remainingMs(duel) {
  const end = endsAt(duel);
  return end ? Math.max(0, end - Date.now()) : duel.durationSec * 1000;
}

function formatTime(ms) {
  const sec = Math.ceil(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

/* ------------------------------------------------------------------ */
/* ターゲットワード                                                    */
/* ------------------------------------------------------------------ */

// このラウンドのワードがまだなければ抽選して保存する
function ensureSecret() {
  const { duel } = state;
  if (state.secret?.round === duel.round) return Promise.resolve(state.secret);
  if (state.secretTask) return state.secretTask;
  state.secretTask = (async () => {
    let secret = await store.getDuelSecret(state.duelId, state.uid);
    if (!secret || secret.round !== duel.round) {
      const word = await pickSniperWord(state.opponent);
      secret = { round: duel.round, wordNo: 1, used: [word.targetWord], ...word };
      await store.setDuelSecret(state.duelId, state.uid, secret);
      state.wordVisible = false;
    }
    state.secret = secret;
    return secret;
  })().finally(() => {
    state.secretTask = null;
  });
  return state.secretTask;
}

// SHOT 成功・COUNTER された後に次のワードを引く
async function drawNextWord() {
  const prev = state.secret;
  const word = await pickSniperWord(state.opponent, prev.used);
  const secret = {
    ...word,
    round: prev.round,
    wordNo: prev.wordNo + 1,
    used: [...prev.used, word.targetWord],
  };
  await store.setDuelSecret(state.duelId, state.uid, secret);
  state.secret = secret;
  state.wordVisible = false;
  renderWord(true);
}

/* ------------------------------------------------------------------ */
/* S10 マッチング                                                      */
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
    ? `${nameOf(opponentId)}さんから再戦の申し込みです`
    : `${nameOf(opponentId)}さんから挑戦が届いています`;
  showView('waiting');
}

/* ------------------------------------------------------------------ */
/* S11 対戦                                                            */
/* ------------------------------------------------------------------ */

function renderScores() {
  const { duel, uid, opponentId } = state;
  const side = (id, label) => `
    ${avatarHtml(playerOf(id), 'sm')}
    <span class="score-meta">
      <span class="score-num">${duel.scores?.[id] ?? 0}</span><br>
      <span class="score-name">${escapeHtml(label)}</span>
    </span>`;
  $('#score-me').innerHTML = side(uid, 'あなた');
  $('#score-opp').innerHTML = side(opponentId, nameOf(opponentId));
}

function renderWord(isNew = false) {
  const { secret } = state;
  if (!secret) {
    $('#word-text').textContent = '抽選中…';
    show($('#word-hint'), false);
    show($('#word-hint-closed'), false);
    return;
  }
  $('#word-text').textContent = secret.targetWord;
  // 攻略ヒントは相手の回答が書いてあるので、ワードと一緒に隠しておく
  $('#word-hint-answer').textContent = secret.hintAnswer || `話題：${secret.hintTheme}`;
  $('#word-hint-talk').textContent = secret.hintTalk || '';
  show($('#word-hint'), state.wordVisible);
  show($('#word-hint-closed'), !state.wordVisible);
  $('#word-no').textContent = `${secret.wordNo}つ目`;
  $('#word-toggle').setAttribute('aria-pressed', String(state.wordVisible));
  if (isNew) {
    const card = $('#word-card');
    card.classList.remove('is-new');
    void card.offsetWidth; // アニメーションをやり直す
    card.classList.add('is-new');
  }
}

function logText(entry) {
  const actor = entry.actor === state.uid ? 'あなた' : `${nameOf(entry.actor)}さん`;
  switch (entry.type) {
    case 'shot':
      return `🎯 ${actor}がSHOT！「${entry.word}」を言わせた（+1）`;
    case 'countered':
      return `🛡️ ${actor}のCOUNTER成功！「${entry.word}」を見破った（+2）`;
    case 'miss':
      return `💦 ${actor}のCOUNTERは不発（−1）`;
    default:
      return '';
  }
}

function renderLog() {
  const { duel } = state;
  const started = toMillis(duel.startedAt);
  const entries = (duel.history || []).filter((h) => h.type !== 'left');
  if (!entries.length) {
    $('#log-list').innerHTML = '<li class="log-empty">まだ動きはありません。さりげなく話しかけてみよう</li>';
    return;
  }
  $('#log-list').innerHTML = entries.slice().reverse().map((h) => {
    const elapsed = started ? Math.max(0, h.at - started) : 0;
    return `<li class="log-item">${escapeHtml(logText(h))}<span class="log-time">${formatTime(elapsed)}</span></li>`;
  }).join('');
}

function renderTimer() {
  const { duel } = state;
  if (!duel || duel.status !== 'playing') return;
  const left = remainingMs(duel);
  $('#timer-text').textContent = formatTime(left);
  $('#timer-bar').style.width = `${(left / (duel.durationSec * 1000)) * 100}%`;
  $('.timer').classList.toggle('is-hurry', left <= HURRY_SECONDS * 1000);
  if (left <= 0) finishDuel();
}

function renderCounterState() {
  const { duel, uid } = state;
  const counter = duel.counter;
  const mine = counter && counter.by === uid;
  const theirs = counter && counter.by !== uid;
  show($('#modal-counter-wait'), !!mine);
  if (theirs && state.secret) {
    $('#modal-judge-name').textContent = nameOf(counter.by);
    $('#modal-judge-word').textContent = state.secret.targetWord;
  }
  show($('#modal-judge'), !!theirs && !!state.secret);
  $('#btn-counter').disabled = !!counter;
}

// 守りのヒント：相手のワードは自分の回答から出ている
function renderGuardHint() {
  const themes = answeredQuestions(state.me).map((q) => q.theme);
  $('#guard-hint').textContent = themes.length
    ? `🛡️ 守りのヒント：${nameOf(state.opponentId)}さんのワードは、あなたの回答（${themes.join('・')}）から出ています。その話を振られたら要注意！`
    : `🛡️ 守りのヒント：あなたはアンケート未回答なので、${nameOf(state.opponentId)}さんのワードは雑談のトークテーマから出ています。`;
}

function renderPlaying() {
  showView('playing');
  renderScores();
  renderWord();
  renderGuardHint();
  renderLog();
  renderTimer();
  renderCounterState();
  if (state.shownStartFor !== state.duel.round && remainingMs(state.duel) > (state.duel.durationSec - 3) * 1000) {
    state.shownStartFor = state.duel.round;
    show($('#start-overlay'), true);
    vibrate([60, 40, 60]);
    setTimeout(() => show($('#start-overlay'), false), 1000);
  }
  state.shownStartFor = state.duel.round;
}

// 時間切れ：最初に気付いた端末が終了を書き込む
async function finishDuel() {
  if (state.finishing) return;
  state.finishing = true;
  const { round } = state.duel;
  try {
    await store.updateDuel(state.duelId, (d) => (d.status === 'playing' && d.round === round
      ? { status: 'finished', counter: null }
      : null));
  } catch (err) {
    console.warn(err);
    state.finishing = false;
  }
}

/* ---------- SHOT ---------- */

async function confirmShot() {
  if (state.busy || !state.secret) return;
  state.busy = true;
  closeModal('modal-shot');
  const { secret, uid } = state;
  try {
    const ok = await store.updateDuel(state.duelId, (d) => {
      if (d.status !== 'playing' || d.round !== secret.round) return null;
      return {
        scores: { ...d.scores, [uid]: (d.scores[uid] || 0) + 1 },
        history: [...(d.history || []), {
          type: 'shot', actor: uid, owner: uid, word: secret.targetWord, sourceLabel: secret.sourceLabel, at: Date.now(),
        }],
      };
    });
    if (ok) {
      vibrate(80);
      toast(`SHOT成功！「${secret.targetWord}」 +1`);
      await drawNextWord();
    }
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    state.busy = false;
  }
}

/* ---------- COUNTER ---------- */

async function declareCounter() {
  if (state.busy) return;
  state.busy = true;
  const { uid } = state;
  try {
    await store.updateDuel(state.duelId, (d) => (d.status === 'playing' && !d.counter
      ? { counter: { by: uid, at: Date.now() } }
      : null));
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    state.busy = false;
  }
}

async function cancelCounter() {
  const { uid } = state;
  try {
    await store.updateDuel(state.duelId, (d) => (d.counter?.by === uid ? { counter: null } : null));
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

// 相手の COUNTER を判定する（判定するのはワードの持ち主）
async function judgeCounter(hit) {
  if (state.busy || !state.secret) return;
  state.busy = true;
  const { uid, secret } = state;
  try {
    const ok = await store.updateDuel(state.duelId, (d) => {
      if (!d.counter || d.counter.by === uid) return null;
      const by = d.counter.by;
      const entry = hit
        ? { type: 'countered', actor: by, owner: uid, word: secret.targetWord, sourceLabel: secret.sourceLabel, at: Date.now() }
        : { type: 'miss', actor: by, owner: null, word: null, at: Date.now() };
      return {
        counter: null,
        scores: { ...d.scores, [by]: (d.scores[by] || 0) + (hit ? 2 : -1) },
        history: [...(d.history || []), entry],
      };
    });
    closeModal('modal-judge');
    if (ok && hit) {
      toast('見破られた…新しいワードが届きました');
      await drawNextWord();
    }
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    state.busy = false;
  }
}

/* ------------------------------------------------------------------ */
/* S12 結果                                                            */
/* ------------------------------------------------------------------ */

// 終了時に、言わせられなかった自分のワードを公開する
async function revealLeftWord() {
  const { duel, uid } = state;
  if (state.revealing || duel.revealed?.[uid]) return;
  state.revealing = true;
  try {
    const secret = await store.getDuelSecret(state.duelId, uid);
    await store.updateDuel(state.duelId, (d) => {
      if (d.revealed?.[uid] || d.status !== 'finished') return null;
      const history = [...(d.history || [])];
      if (secret && secret.round === d.round) {
        history.push({
          type: 'left', actor: uid, owner: uid, word: secret.targetWord, sourceLabel: secret.sourceLabel, at: Date.now(),
        });
      }
      return { revealed: { ...d.revealed, [uid]: true }, history };
    });
  } catch (err) {
    console.warn(err);
  } finally {
    state.revealing = false;
  }
}

function wordItemsHtml(ownerId) {
  const items = (state.duel.history || []).filter((h) => h.owner === ownerId && h.word);
  if (!items.length) {
    return `<li class="word-item-empty">${state.duel.revealed?.[ownerId] ? 'ワードはありませんでした' : '公開を待っています…'}</li>`;
  }
  const badge = {
    shot: '<span class="badge badge-shot">SHOT成功</span>',
    countered: '<span class="badge badge-countered">見破られた</span>',
    left: '<span class="badge">時間切れ</span>',
  };
  return items.map((h) => `
    <li class="word-item">
      <span class="word-item-body">
        <span class="word-item-word">${escapeHtml(h.word)}</span><br>
        <span class="word-item-source">${escapeHtml(h.sourceLabel || '')}</span>
      </span>
      ${badge[h.type] || ''}
    </li>`).join('');
}

function renderResult() {
  closeModal('modal-shot');
  closeModal('modal-judge');
  closeModal('modal-counter-wait');
  const { duel, uid, opponentId } = state;
  const mine = duel.scores?.[uid] ?? 0;
  const theirs = duel.scores?.[opponentId] ?? 0;
  if (mine > theirs) {
    $('#result-emoji').textContent = '🏆';
    $('#result-title').textContent = 'あなたの勝ち！';
  } else if (mine < theirs) {
    $('#result-emoji').textContent = '💘';
    $('#result-title').textContent = `${nameOf(opponentId)}さんの勝ち`;
  } else {
    $('#result-emoji').textContent = '🤝';
    $('#result-title').textContent = '引き分け';
  }
  $('#result-score').innerHTML = `
    ${avatarHtml(playerOf(uid), 'md')}<span>${mine}</span>
    <span class="muted">-</span>
    <span>${theirs}</span>${avatarHtml(playerOf(opponentId), 'md')}`;
  $('#result-opp-label').textContent = `${nameOf(opponentId)}さんのワード`;
  $('#result-my-words').innerHTML = wordItemsHtml(uid);
  $('#result-opp-words').innerHTML = wordItemsHtml(opponentId);
  showView('result');
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
  const prevStatus = state.duel?.status;
  state.duel = duel;
  state.opponentId = duel.playerIds.find((id) => id !== state.uid);
  if (!state.opponent || state.opponent.id !== state.opponentId) {
    state.opponent = await store.getPlayer(state.opponentId);
  }
  if (duel.status !== 'playing') state.finishing = false;

  switch (duel.status) {
    case 'waiting':
      renderWaiting();
      break;
    case 'playing':
      renderPlaying();
      try {
        await ensureSecret();
        renderWord();
        renderCounterState();
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
      break;
    case 'finished':
      if (prevStatus === 'playing') vibrate([100, 60, 100]);
      renderResult();
      revealLeftWord();
      break;
    default:
      showView('cancelled');
  }
  bot.onDuel(duel);
}

/* ------------------------------------------------------------------ */
/* ローカルモード専用：テスト相手（ボット）の動き                        */
/* ------------------------------------------------------------------ */

const bot = {
  timers: [],
  round: null,
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

    // 再戦の申し込みにはすぐ応じる
    if (duel.status === 'waiting' && !duel.joined?.[botId]) {
      this.later(800, () => store.updateDuel(state.duelId, (d) => (d.status === 'waiting'
        ? { joined: { ...d.joined, [botId]: true }, status: 'playing', startedAt: Date.now() }
        : null)));
      return;
    }

    // あなたの COUNTER を判定（半々で当たり）
    if (duel.status === 'playing' && duel.counter?.by === state.uid) {
      this.later(1500, () => store.updateDuel(state.duelId, (d) => {
        if (d.counter?.by !== state.uid) return null;
        const hit = Math.random() < 0.5;
        return {
          counter: null,
          scores: { ...d.scores, [state.uid]: d.scores[state.uid] + (hit ? 2 : -1) },
          history: [...d.history, hit
            ? { type: 'countered', actor: state.uid, owner: botId, word: 'ダミーワード', sourceLabel: 'テスト相手のワード', at: Date.now() }
            : { type: 'miss', actor: state.uid, owner: null, word: null, at: Date.now() }],
        };
      }));
    }

    // ラウンド開始時に、ボットの SHOT と COUNTER を1回ずつ予約
    if (duel.status === 'playing' && this.round !== duel.round) {
      this.round = duel.round;
      this.clear();
      this.later(15000 + Math.random() * 20000, () => store.updateDuel(state.duelId, (d) => (d.status === 'playing'
        ? {
          scores: { ...d.scores, [botId]: d.scores[botId] + 1 },
          history: [...d.history, {
            type: 'shot', actor: botId, owner: botId, word: '旅行', sourceLabel: 'テスト相手のワード', at: Date.now(),
          }],
        }
        : null)));
      this.later(45000 + Math.random() * 20000, () => store.updateDuel(state.duelId, (d) => (d.status === 'playing' && !d.counter
        ? { counter: { by: botId, at: Date.now() } }
        : null)));
    }

    if (duel.status === 'finished' && !duel.revealed?.[botId]) {
      this.clear();
      store.updateDuel(state.duelId, (d) => (d.revealed?.[botId] ? null : {
        revealed: { ...d.revealed, [botId]: true },
        history: [...d.history, {
          type: 'left', actor: botId, owner: botId, word: 'カフェ', sourceLabel: 'テスト相手のワード', at: Date.now(),
        }],
      }));
    }
  },
};

/* ------------------------------------------------------------------ */
/* 起動                                                                */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $('#word-toggle').addEventListener('click', () => {
    state.wordVisible = !state.wordVisible;
    renderWord();
  });
  $('#btn-shot').addEventListener('click', () => {
    if (!state.secret) return;
    $('#modal-shot-word').textContent = state.secret.targetWord;
    openModal('modal-shot');
  });
  $('#modal-shot-yes').addEventListener('click', confirmShot);
  $('#btn-counter').addEventListener('click', declareCounter);
  $('#modal-counter-cancel').addEventListener('click', cancelCounter);
  $('#modal-judge-hit').addEventListener('click', () => judgeCounter(true));
  $('#modal-judge-miss').addEventListener('click', () => judgeCounter(false));
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.closest('.modal').id));
  });

  const rejoin = async () => {
    try {
      await store.enterDuel(state.uid, state.opponentId, state.me);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  $('#wait-accept').addEventListener('click', rejoin);
  $('#result-rematch').addEventListener('click', rejoin);
  $('#cancelled-retry').addEventListener('click', rejoin);

  const cancel = async () => {
    try {
      await store.updateDuel(state.duelId, (d) => (d.status === 'waiting' ? { status: 'cancelled' } : null));
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  $('#wait-cancel').addEventListener('click', cancel);
  $('#wait-decline').addEventListener('click', cancel);
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
    state.duelId = await store.enterDuel(state.uid, opponentId, state.me);
    history.replaceState(null, '', `sniper.html?duel=${encodeURIComponent(state.duelId)}`);
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
  setInterval(renderTimer, 250);
}

main().catch(showFatal);
