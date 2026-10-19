// S09 1対1のモード選択
//   versus.html?opponent=<uid>  相手の個人カードをタッチしたとき
// 相手から挑戦が届いていればそれを受けられるようにし、なければモードを選んで申し込む。
// 申し込み・参加は各モードの画面（sniper.html / defuse.html / bet.html）が ?opponent= で行う。
import { signIn } from './firebase.js';
import {
  store, toMillis, duelIdFor, duelModeOf, duelPage, GameError,
} from './store.js';
import {
  $, avatarHtml, escapeHtml, show, showFatal, showLocalBanner,
} from './ui.js';

const params = new URLSearchParams(location.search);
const FRESH_MS = 10 * 60 * 1000;
const MODE_NAMES = { sniper: 'ワード・スナイパー', defuse: '時限爆弾解除', bet: 'ステータス・ベット' };

function versusHtml(player, label) {
  return `
    ${avatarHtml(player, 'lg')}
    <span class="versus-name">${escapeHtml(player.nickname)}</span>
    <span class="versus-state">${escapeHtml(label)}</span>`;
}

function goMode(mode, opponentId) {
  location.href = `${duelPage(mode)}?opponent=${encodeURIComponent(opponentId)}`;
}

async function main() {
  showLocalBanner();
  const uid = await signIn();
  const me = await store.getPlayer(uid);
  if (!me?.nickname) {
    location.replace(`profile.html?next=${encodeURIComponent(`versus.html${location.search}`)}`);
    return;
  }
  const opponentId = params.get('opponent');
  if (!opponentId || opponentId === uid) {
    location.replace('lobby.html');
    return;
  }
  const opponent = await store.getPlayer(opponentId);
  if (!opponent) throw new GameError('PLAYER_NOT_FOUND', '相手のプロフィールが見つかりません。');

  let duel = null;
  try {
    duel = await store.getDuel(duelIdFor(uid, opponentId));
  } catch (err) {
    console.warn(err);
  }

  $('#vs-me').innerHTML = versusHtml(me, 'あなた');
  $('#vs-opp').innerHTML = versusHtml(opponent, 'カードの持ち主');

  const fresh = duel && Date.now() - toMillis(duel.updatedAt) < FRESH_MS;
  const mode = duelModeOf(duel);
  const link = duel ? `${duelPage(mode)}?duel=${encodeURIComponent(duel.id)}` : '#';
  if (fresh && duel.status === 'waiting' && !duel.joined?.[uid]) {
    $('#vs-invite-text').textContent = `${opponent.nickname}さんから「${MODE_NAMES[mode]}」の挑戦が届いています`;
    $('#vs-invite-accept').addEventListener('click', () => goMode(mode, opponentId));
    show($('#vs-invite'), true);
    $('#vs-choose-label').textContent = 'ほかのモードで申し込み直すこともできます';
  } else if (fresh && duel.status === 'waiting') {
    $('#vs-resume-text').textContent = `「${MODE_NAMES[mode]}」を申し込み中です`;
    $('#vs-resume-link').href = link;
    show($('#vs-resume'), true);
  } else if (fresh && duel.status === 'playing') {
    $('#vs-resume-text').textContent = `「${MODE_NAMES[mode]}」の対戦中です`;
    $('#vs-resume-link').href = link;
    show($('#vs-resume'), true);
  }

  document.querySelectorAll('.mode-card').forEach((btn) => {
    btn.addEventListener('click', () => goMode(btn.dataset.mode, opponentId));
  });
  show($('#view-loading'), false);
  show($('#view-choose'), true);
}

main().catch(showFatal);
