// S10 マッチング / S11 ワード・スナイパー対戦（ターン制） / S12 結果
//   sniper.html?opponent=<uid>  相手の個人カードをタッチしたとき（対戦に参加して ?duel= に置き換える）
//   sniper.html?duel=<duelId>   挑戦の受諾・再読み込み・再戦
//
// 対戦の流れ：先攻の準備（ready）→ 先攻の攻撃（active）→ 後攻の準備 → 後攻の攻撃 → 結果
//   攻撃する人だけがワードと質問例を持ち、相手に言わせたら SHOT（+1）。
//   守る人は質問に正直に答え、ワードに気付いたら「見破った！」（当たり+1／はずれ−1、判定は攻撃する人）。
import { signIn, isLocalMode } from './firebase.js';
import {
  store, toMillis, attackerOf, SERVER_TIME, TURN_SECONDS, TOTAL_TURNS,
} from './store.js';
import { pickSniperWord, answeredQuestions } from './topics.js';
import {
  $, avatarHtml, escapeHtml, show, toast, errorMessage, showFatal, showLocalBanner,
} from './ui.js';

const params = new URLSearchParams(location.search);
const HURRY_SECONDS = 15;

const state = {
  uid: null,
  me: null,
  duelId: null,
  duel: null,
  opponentId: null,
  opponent: null, // 相手の players ドキュメント（ワード抽選に使う）
  secret: null, // 自分のワード（攻撃ターンのもの）
  secretTask: null,
  wordVisible: false,
  ending: null, // 終了処理中のターン
  revealing: false,
  shownStartFor: null,
  busy: false,
};

/* ------------------------------------------------------------------ */
/* 表示の切り替え                                                      */
/* ------------------------------------------------------------------ */

const VIEWS = ['loading', 'waiting', 'turn', 'playing', 'result', 'cancelled'];
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

function totalTurns(duel) {
  return duel.totalTurns || TOTAL_TURNS;
}
function turnSec(duel) {
  return duel.turnSec || TURN_SECONDS;
}
function turnKey(duel) {
  return `${duel.round}:${duel.turnIndex}`;
}
function isMyAttack(duel = state.duel) {
  return attackerOf(duel) === state.uid;
}
// 「先攻」「後攻」（1人2ターン以上のときは「先攻 2回目」など）
function turnLabel(duel, turnIndex = duel.turnIndex) {
  const side = turnIndex % 2 === 0 ? '先攻' : '後攻';
  const nth = Math.floor(turnIndex / 2) + 1;
  return totalTurns(duel) > 2 ? `${side} ${nth}回目` : side;
}

function turnEndsAt(duel) {
  const started = toMillis(duel.turnStartedAt);
  return started ? started + turnSec(duel) * 1000 : 0;
}

function remainingMs(duel) {
  const end = turnEndsAt(duel);
  return end ? Math.max(0, end - Date.now()) : turnSec(duel) * 1000;
}

function formatTime(ms) {
  const sec = Math.ceil(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

/* ------------------------------------------------------------------ */
/* ワード（攻撃する人だけが持つ）                                        */
/* ------------------------------------------------------------------ */

// 自分の攻撃ターンのワードがまだなければ抽選して保存する
function ensureSecret() {
  const { duel } = state;
  const turn = duel.turnIndex;
  if (state.secret?.round === duel.round && state.secret?.turn === turn) return Promise.resolve(state.secret);
  if (state.secretTask) return state.secretTask;
  state.secretTask = (async () => {
    let secret = await store.getDuelSecret(state.duelId, state.uid);
    if (!secret || secret.round !== duel.round || secret.turn !== turn) {
      // 同じラウンドで前に使ったワードは避ける
      const used = secret?.round === duel.round ? (secret.used || []) : [];
      const word = await pickSniperWord(state.opponent, used);
      secret = {
        ...word,
        round: duel.round,
        turn,
        wordNo: 1,
        used: [...used, word.targetWord],
      };
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

// SHOT・パス・見破られた後に次のワードを引く
async function drawNextWord() {
  const prev = state.secret;
  const word = await pickSniperWord(state.opponent, prev.used);
  const secret = {
    ...word,
    round: prev.round,
    turn: prev.turn,
    wordNo: prev.wordNo + 1,
    used: [...prev.used, word.targetWord],
  };
  await store.setDuelSecret(state.duelId, state.uid, secret);
  state.secret = secret;
  state.wordVisible = false;
  renderWord(true);
}

// 今のターンのワードを持っているか
function hasCurrentSecret() {
  const { secret, duel } = state;
  return !!secret && secret.round === duel.round && secret.turn === duel.turnIndex;
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
  $('#rules-turn-sec').textContent = turnSec(duel);
  showView('waiting');
}

/* ------------------------------------------------------------------ */
/* ターンの準備（攻守交代）                                              */
/* ------------------------------------------------------------------ */

function scoreLineHtml() {
  const { duel, uid, opponentId } = state;
  return `
    ${avatarHtml(playerOf(uid), 'md')}<span>${duel.scores?.[uid] ?? 0}</span>
    <span class="muted">-</span>
    <span>${duel.scores?.[opponentId] ?? 0}</span>${avatarHtml(playerOf(opponentId), 'md')}`;
}

function renderTurnReady() {
  const { duel, opponentId } = state;
  const mine = isMyAttack(duel);
  const first = duel.turnIndex === 0;
  const sec = turnSec(duel);
  $('#turn-step').textContent = `${turnLabel(duel)}（${duel.turnIndex + 1}/${totalTurns(duel)}ターン）`;
  $('#turn-emoji').textContent = mine ? '⚔️' : '🛡️';
  if (mine) {
    $('#turn-title').textContent = first ? 'あなたが先攻です' : '攻守交代！あなたの攻撃ターン';
    $('#turn-desc').textContent = `スタートを押すと、${nameOf(opponentId)}さんに言わせるワードと質問例が届きます。${sec}秒のあいだに、質問してワードを言わせよう。`;
  } else {
    $('#turn-title').textContent = first
      ? `${nameOf(opponentId)}さんが先攻です`
      : `攻守交代！${nameOf(opponentId)}さんの攻撃ターン`;
    $('#turn-desc').textContent = `${nameOf(opponentId)}さんがあなたに質問します。正直に答えながら、狙われているワードを見破ろう。`;
  }
  $('#turn-score').innerHTML = scoreLineHtml();
  show($('#turn-score'), !first);
  $('#turn-start').textContent = `スタート（${sec}秒）`;
  show($('#turn-start'), mine);
  show($('#turn-wait'), !mine);
  $('#turn-wait-text').textContent = `${nameOf(opponentId)}さんがスタートするのを待っています`;
  closeModal('modal-shot');
  closeModal('modal-judge');
  closeModal('modal-counter-wait');
  showView('turn');
}

async function startTurn() {
  if (state.busy) return;
  state.busy = true;
  const { uid } = state;
  const { round, turnIndex } = state.duel;
  try {
    await store.updateDuel(state.duelId, (d) => (d.status === 'playing' && d.round === round
      && d.turnIndex === turnIndex && d.turnPhase === 'ready' && attackerOf(d) === uid
      ? { turnPhase: 'active', turnStartedAt: SERVER_TIME, counter: null }
      : null));
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    state.busy = false;
  }
}

// 時間切れ：最初に気付いた端末が次のターン（最後なら結果）に進める
async function endTurn() {
  const { duel } = state;
  const key = turnKey(duel);
  if (state.ending === key) return;
  state.ending = key;
  const { round, turnIndex } = duel;
  try {
    await store.updateDuel(state.duelId, (d) => {
      if (d.status !== 'playing' || d.round !== round || d.turnIndex !== turnIndex || d.turnPhase !== 'active') return null;
      if (turnIndex + 1 >= totalTurns(d)) return { status: 'finished', counter: null };
      return {
        turnIndex: turnIndex + 1, turnPhase: 'ready', turnStartedAt: null, counter: null,
      };
    });
  } catch (err) {
    console.warn(err);
    state.ending = null;
  }
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
  if (!hasCurrentSecret()) {
    $('#word-text').textContent = '抽選中…';
    show($('#word-hint'), false);
    show($('#word-hint-closed'), false);
    return;
  }
  const { secret } = state;
  $('#word-text').textContent = secret.targetWord;
  // 質問例と相手の回答はワードの手がかりになるので、ワードと一緒に隠しておく
  $('#word-questions').innerHTML = (secret.questions || [])
    .map((q) => `<li>「${escapeHtml(q)}」</li>`).join('');
  $('#word-hint-answer').textContent = secret.hintAnswer || '';
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
      return `🛡️ ${actor}が見破った！「${entry.word}」（+1）`;
    case 'miss':
      return `💦 ${actor}の「見破った！」ははずれ（−1）`;
    case 'pass':
      return `⏭ ${actor}がワードをパス`;
    default:
      return '';
  }
}

function renderLog() {
  const entries = (state.duel.history || []).filter((h) => h.type !== 'left');
  if (!entries.length) {
    $('#log-list').innerHTML = '<li class="log-empty">まだ動きはありません</li>';
    return;
  }
  $('#log-list').innerHTML = entries.slice().reverse().map((h) => {
    const tag = Number.isInteger(h.turn) ? turnLabel(state.duel, h.turn) : '';
    return `<li class="log-item">${escapeHtml(logText(h))}<span class="log-time">${escapeHtml(tag)}</span></li>`;
  }).join('');
}

function renderTimer() {
  const { duel } = state;
  if (!duel || duel.status !== 'playing' || duel.turnPhase !== 'active') return;
  const left = remainingMs(duel);
  $('#timer-text').textContent = formatTime(left);
  $('#timer-bar').style.width = `${(left / (turnSec(duel) * 1000)) * 100}%`;
  $('.timer').classList.toggle('is-hurry', left <= HURRY_SECONDS * 1000);
  if (left <= 0) endTurn();
}

function renderCounterState() {
  const { duel, uid } = state;
  const counter = duel.counter;
  const mine = !!counter && counter.by === uid;
  // 相手の宣言を判定するのは、攻撃していてワードを持っている人
  const judge = !!counter && counter.by !== uid && isMyAttack(duel) && hasCurrentSecret();
  show($('#modal-counter-wait'), mine);
  if (judge) {
    $('#modal-judge-name').textContent = nameOf(counter.by);
    $('#modal-judge-word').textContent = state.secret.targetWord;
  }
  show($('#modal-judge'), judge);
  $('#btn-counter').disabled = !!counter;
}

// 守りのヒント：相手のワードは自分の回答から出ている
function renderDefend() {
  const opp = nameOf(state.opponentId);
  $('#defend-title').textContent = `${opp}さんの質問に正直に答えよう`;
  $('#defend-desc').textContent = `${opp}さんは、あなたに言わせたいワードを狙って質問してきます。うそはNGですが、言い方を工夫してかわすのはOK。`;
  const themes = answeredQuestions(state.me).map((q) => q.theme);
  $('#guard-hint').textContent = themes.length
    ? `🛡️ ヒント：ワードは、あなたのアンケート回答（${themes.join('・')}）から出ています。`
    : '🛡️ ヒント：あなたはアンケート未回答なので、ワードは雑談のトークテーマから出ています。';
}

function renderPlaying() {
  const { duel } = state;
  const mine = isMyAttack(duel);
  showView('playing');
  renderScores();
  const banner = $('#turn-banner');
  banner.textContent = mine
    ? `⚔️ あなたの攻撃ターン（${turnLabel(duel)}）`
    : `🛡️ ${nameOf(state.opponentId)}さんの攻撃ターン（${turnLabel(duel)}）`;
  banner.classList.toggle('is-attack', mine);
  banner.classList.toggle('is-defend', !mine);
  show($('#attack-panel'), mine);
  show($('#defend-panel'), !mine);
  if (mine) renderWord();
  else renderDefend();
  renderLog();
  renderTimer();
  renderCounterState();

  const key = turnKey(duel);
  if (state.shownStartFor !== key && remainingMs(duel) > (turnSec(duel) - 3) * 1000) {
    $('#start-text').textContent = duel.turnIndex === 0 ? 'START!' : '攻守交代！';
    show($('#start-overlay'), true);
    vibrate([60, 40, 60]);
    setTimeout(() => show($('#start-overlay'), false), 1000);
  }
  state.shownStartFor = key;
}

/* ---------- SHOT ---------- */

async function confirmShot() {
  if (state.busy || !hasCurrentSecret()) return;
  state.busy = true;
  closeModal('modal-shot');
  const { secret, uid } = state;
  try {
    const ok = await store.updateDuel(state.duelId, (d) => {
      if (d.status !== 'playing' || d.round !== secret.round || d.turnIndex !== secret.turn || d.turnPhase !== 'active') return null;
      return {
        scores: { ...d.scores, [uid]: (d.scores[uid] || 0) + 1 },
        history: [...(d.history || []), {
          type: 'shot', actor: uid, owner: uid, turn: secret.turn, word: secret.targetWord, sourceLabel: secret.sourceLabel, at: Date.now(),
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

/* ---------- パス ---------- */

async function passWord() {
  if (state.busy || !hasCurrentSecret()) return;
  state.busy = true;
  const { secret, uid } = state;
  try {
    const ok = await store.updateDuel(state.duelId, (d) => {
      if (d.status !== 'playing' || d.round !== secret.round || d.turnIndex !== secret.turn || d.turnPhase !== 'active') return null;
      return {
        history: [...(d.history || []), {
          type: 'pass', actor: uid, owner: uid, turn: secret.turn, word: secret.targetWord, sourceLabel: secret.sourceLabel, at: Date.now(),
        }],
      };
    });
    if (ok) {
      toast('パスしました。次のワードです');
      await drawNextWord();
    }
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    state.busy = false;
  }
}

/* ---------- 見破った！（守る人の宣言） ---------- */

async function declareCounter() {
  if (state.busy) return;
  state.busy = true;
  const { uid } = state;
  try {
    await store.updateDuel(state.duelId, (d) => (d.status === 'playing' && d.turnPhase === 'active'
      && attackerOf(d) !== uid && !d.counter
      ? { counter: { by: uid, turn: d.turnIndex, at: Date.now() } }
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

// 相手の宣言を判定する（判定するのはワードを持っている攻撃側）
async function judgeCounter(hit) {
  if (state.busy || !hasCurrentSecret()) return;
  state.busy = true;
  const { uid, secret } = state;
  try {
    const ok = await store.updateDuel(state.duelId, (d) => {
      if (!d.counter || d.counter.by === uid || d.turnIndex !== secret.turn) return null;
      const by = d.counter.by;
      const entry = hit
        ? {
          type: 'countered', actor: by, owner: uid, turn: secret.turn, word: secret.targetWord, sourceLabel: secret.sourceLabel, at: Date.now(),
        }
        : {
          type: 'miss', actor: by, owner: null, turn: secret.turn, word: null, at: Date.now(),
        };
      return {
        counter: null,
        scores: { ...d.scores, [by]: (d.scores[by] || 0) + (hit ? 1 : -1) },
        history: [...(d.history || []), entry],
      };
    });
    closeModal('modal-judge');
    if (ok && hit) {
      toast('見破られた…次のワードです');
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

// 終わったターンのうち、自分が攻撃したターンを数える
function myEndedTurns(duel) {
  const ended = duel.status === 'finished' ? totalTurns(duel) : duel.turnIndex;
  const turns = [];
  for (let t = 0; t < ended; t += 1) {
    if (attackerOf(duel, t) === state.uid) turns.push(t);
  }
  return turns;
}

// ターンが終わったら、言わせられなかった最後のワードを公開する
async function revealLeftWords() {
  const { duel, uid } = state;
  if (state.revealing) return;
  const pending = myEndedTurns(duel).filter((t) => !duel.revealed?.[`t${t}`]);
  if (!pending.length) return;
  state.revealing = true;
  try {
    const secret = state.secret?.round === duel.round
      ? state.secret
      : await store.getDuelSecret(state.duelId, uid);
    await store.updateDuel(state.duelId, (d) => {
      if (d.round !== duel.round) return null;
      const revealed = { ...d.revealed };
      const history = [...(d.history || [])];
      let changed = false;
      pending.forEach((t) => {
        if (revealed[`t${t}`]) return;
        revealed[`t${t}`] = true;
        changed = true;
        if (secret && secret.round === d.round && secret.turn === t) {
          history.push({
            type: 'left', actor: uid, owner: uid, turn: t, word: secret.targetWord, sourceLabel: secret.sourceLabel, at: Date.now(),
          });
        }
      });
      return changed ? { revealed, history } : null;
    });
  } catch (err) {
    console.warn(err);
  } finally {
    state.revealing = false;
  }
}

function wordItemsHtml(ownerId) {
  const { duel } = state;
  const items = (duel.history || []).filter((h) => h.owner === ownerId && h.word);
  const ownerTurns = [];
  for (let t = 0; t < totalTurns(duel); t += 1) {
    if (attackerOf(duel, t) === ownerId) ownerTurns.push(t);
  }
  const allRevealed = ownerTurns.every((t) => duel.revealed?.[`t${t}`]);
  if (!items.length) {
    return `<li class="word-item-empty">${allRevealed ? 'ワードはありませんでした' : '公開を待っています…'}</li>`;
  }
  const badge = {
    shot: '<span class="badge badge-shot">SHOT成功</span>',
    countered: '<span class="badge badge-countered">見破られた</span>',
    pass: '<span class="badge">パス</span>',
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
  $('#result-score').innerHTML = scoreLineHtml();
  $('#result-opp-label').textContent = `${nameOf(opponentId)}さんが狙ったワード`;
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

  // ターン制になる前の対戦は続けられないので、申し込み直してもらう
  if ((duel.status === 'waiting' || duel.status === 'playing') && !duel.turnOrder) {
    $('#cancelled-title').textContent = 'ルールが新しくなりました';
    showView('cancelled');
    return;
  }

  switch (duel.status) {
    case 'waiting':
      renderWaiting();
      break;
    case 'playing':
      revealLeftWords();
      if (duel.turnPhase === 'ready') {
        renderTurnReady();
        // 攻撃する人は、スタート前にワードを用意しておく
        if (isMyAttack(duel)) ensureSecret().catch((err) => toast(errorMessage(err), 'error'));
      } else {
        renderPlaying();
        if (isMyAttack(duel)) {
          try {
            await ensureSecret();
            if (state.duel === duel) {
              renderWord();
              renderCounterState();
            }
          } catch (err) {
            toast(errorMessage(err), 'error');
          }
        }
      }
      break;
    case 'finished':
      if (prevStatus === 'playing') vibrate([100, 60, 100]);
      renderResult();
      revealLeftWords();
      break;
    default:
      $('#cancelled-title').textContent = '対戦はキャンセルされました';
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
    if (!this.active || !duel.turnOrder) return;
    const botId = state.opponentId;
    const you = state.uid;

    // 再戦の申し込みにはすぐ応じる
    if (duel.status === 'waiting' && !duel.joined?.[botId]) {
      this.later(800, () => store.updateDuel(state.duelId, (d) => (d.status === 'waiting'
        ? { joined: { ...d.joined, [botId]: true }, status: 'playing', startedAt: Date.now() }
        : null)));
      return;
    }

    // ボットが攻撃する番の準備：すぐスタート
    const key = `${duel.round}:${duel.turnIndex}:${duel.turnPhase}`;
    if (duel.status === 'playing' && this.key !== key) {
      this.key = key;
      this.clear();
      const turn = duel.turnIndex;
      const botAttacks = attackerOf(duel) === botId;
      if (duel.turnPhase === 'ready' && botAttacks) {
        this.later(1500, () => store.updateDuel(state.duelId, (d) => (d.turnIndex === turn && d.turnPhase === 'ready'
          ? { turnPhase: 'active', turnStartedAt: Date.now(), counter: null }
          : null)));
      }
      // ボットの攻撃ターン：途中で1回 SHOT
      if (duel.turnPhase === 'active' && botAttacks) {
        this.later(12000 + Math.random() * 15000, () => store.updateDuel(state.duelId, (d) => (d.turnIndex === turn && d.turnPhase === 'active'
          ? {
            scores: { ...d.scores, [botId]: d.scores[botId] + 1 },
            history: [...d.history, {
              type: 'shot', actor: botId, owner: botId, turn, word: '旅行', sourceLabel: 'テスト相手のワード', at: Date.now(),
            }],
          }
          : null)));
      }
      // あなたの攻撃ターン：途中で1回「見破った！」
      if (duel.turnPhase === 'active' && !botAttacks) {
        this.later(30000 + Math.random() * 20000, () => store.updateDuel(state.duelId, (d) => (d.turnIndex === turn && d.turnPhase === 'active' && !d.counter
          ? { counter: { by: botId, turn, at: Date.now() } }
          : null)));
      }
    }

    // あなたの「見破った！」をボットが判定（半々で当たり）
    if (duel.status === 'playing' && duel.counter?.by === you && attackerOf(duel) === botId) {
      const turn = duel.turnIndex;
      this.later(1500, () => store.updateDuel(state.duelId, (d) => {
        if (d.counter?.by !== you || d.turnIndex !== turn) return null;
        const hit = Math.random() < 0.5;
        return {
          counter: null,
          scores: { ...d.scores, [you]: d.scores[you] + (hit ? 1 : -1) },
          history: [...d.history, hit
            ? {
              type: 'countered', actor: you, owner: botId, turn, word: 'ダミーワード', sourceLabel: 'テスト相手のワード', at: Date.now(),
            }
            : {
              type: 'miss', actor: you, owner: null, turn, word: null, at: Date.now(),
            }],
        };
      }));
    }

    // ボットの攻撃ターンが終わったら、最後のワードを公開
    const ended = duel.status === 'finished' ? totalTurns(duel) : duel.turnIndex;
    for (let t = 0; t < ended; t += 1) {
      if (attackerOf(duel, t) === botId && !duel.revealed?.[`t${t}`]) {
        store.updateDuel(state.duelId, (d) => (d.revealed?.[`t${t}`] ? null : {
          revealed: { ...d.revealed, [`t${t}`]: true },
          history: [...d.history, {
            type: 'left', actor: botId, owner: botId, turn: t, word: 'カフェ', sourceLabel: 'テスト相手のワード', at: Date.now(),
          }],
        }));
      }
    }
    if (duel.status === 'finished') this.clear();
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
  $('#turn-start').addEventListener('click', startTurn);
  $('#btn-shot').addEventListener('click', () => {
    if (!hasCurrentSecret()) return;
    $('#modal-shot-word').textContent = state.secret.targetWord;
    openModal('modal-shot');
  });
  $('#modal-shot-yes').addEventListener('click', confirmShot);
  $('#btn-pass').addEventListener('click', passWord);
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
