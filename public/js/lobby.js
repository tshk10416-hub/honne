// S03 待機画面（ホーム） / S20 ルームロビー
//   lobby.html             ホーム
//   lobby.html?linked=1    個人カードを登録した直後のホーム
//   lobby.html?room=xxx    ルームロビー
import { signIn, isLocalMode } from './firebase.js';
import {
  store, toMillis, countAnswered, MIN_MEMBERS, MAX_MEMBERS, ONLINE_TIMEOUT_MS,
} from './store.js';
import { SURVEY } from './survey.js';
import {
  $, avatarHtml, escapeHtml, show, toast, errorMessage, showFatal, showLocalBanner,
} from './ui.js';

const params = new URLSearchParams(location.search);
const HEARTBEAT_MS = 30 * 1000;

// ゲーム中の画面（ステップ4以降で実装）
const MODE_PAGES = {
  profileBet: 'bet.html',
  anonymous: 'anonymous.html',
};

let uid = null;

function showView(name) {
  ['loading', 'home', 'room'].forEach((v) => show($(`#view-${v}`), v === name));
}

/* ------------------------------------------------------------------ */
/* S03 ホーム                                                          */
/* ------------------------------------------------------------------ */

function renderHome(player) {
  $('#home-avatar').innerHTML = avatarHtml(player, 'lg');
  $('#home-name').textContent = player.nickname;

  const cardEl = $('#home-card');
  if (player.cardId) {
    cardEl.innerHTML = `あなたのカード：<strong>${escapeHtml(player.cardId)}</strong>
      <button type="button" class="btn btn-ghost btn-small btn-danger" id="release-card">手放す</button>`;
  } else {
    cardEl.textContent = '自分の個人カードにタッチすると、あなたのカードとして登録されます';
  }

  const count = countAnswered(player.survey);
  $('#home-dots').innerHTML = SURVEY.map((q) => {
    const v = player.survey?.[q.id];
    return `<span class="dot${v === 'A' || v === 'B' ? ' is-answered' : ''}" title="Q${q.order}"></span>`;
  }).join('');
  $('#home-survey-btn').textContent = count ? '見直す' : '回答する';
  $('#home-survey-note').textContent = count === SURVEY.length
    ? '5問すべて回答済み。準備OKです！'
    : `${count}/5問 回答済み。未回答でも用意されたお題で遊べます。`;
}

async function renderResume(player) {
  if (!player.currentRoomId) {
    show($('#home-resume'), false);
    return;
  }
  const room = await store.getRoom(player.currentRoomId);
  const active = room && room.status !== 'finished' && room.memberIds.includes(uid);
  show($('#home-resume'), active);
  if (active) {
    $('#home-resume-code').textContent = `ルームコード ${room.code}`;
    $('#home-resume-link').href = `lobby.html?room=${encodeURIComponent(room.id)}`;
  }
}

async function initHome() {
  showView('home');
  if (params.get('linked') === '1') {
    toast('カードを登録しました！');
    history.replaceState(null, '', 'lobby.html');
  }
  show($('#local-tools'), isLocalMode);

  let lastRoomId;
  await store.watchPlayer(uid, (player) => {
    if (!player?.nickname) {
      location.replace('profile.html');
      return;
    }
    renderHome(player);
    if (player.currentRoomId !== lastRoomId) {
      lastRoomId = player.currentRoomId;
      renderResume(player).catch(console.error);
    }
  });

  $('#home-card').addEventListener('click', async (e) => {
    if (!e.target.closest('#release-card')) return;
    const player = await store.getPlayer(uid);
    if (!player?.cardId) return;
    if (!window.confirm(`カード ${player.cardId} の登録を解除しますか？`)) return;
    try {
      await store.releaseCard(player.cardId, uid);
      toast('カードの登録を解除しました');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  const input = $('#room-code-input');
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 4);
    $('#code-submit').disabled = input.value.length !== 4;
  });
  $('#code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value.length !== 4) return;
    // 入室処理は index.html にまとめてある
    location.href = `index.html?room=${input.value}`;
  });
}

/* ------------------------------------------------------------------ */
/* S20 ルームロビー                                                    */
/* ------------------------------------------------------------------ */

const roomState = { room: null, members: [], leaving: false };

function isOnline(member) {
  if (member.isDummy) return true;
  const seen = toMillis(member.lastSeenAt);
  return !seen || Date.now() - seen < ONLINE_TIMEOUT_MS; // 書き込み直後（seen=0）はオンライン扱い
}

function renderRoom() {
  const { room, members } = roomState;
  if (!room) return;
  const isHost = room.hostId === uid;
  const count = room.memberIds.length;
  const ready = count >= MIN_MEMBERS && count <= MAX_MEMBERS;

  $('#room-code').textContent = room.code;
  $('#member-count').textContent = count;

  // memberIds の順に並べ、members サブコレクションの表示情報を合わせる
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  const rows = room.memberIds.map((id) => {
    const m = byId[id] || { nickname: '読み込み中…', color: '#ccc' };
    const badges = [
      id === room.hostId ? '<span class="badge badge-host">ホスト</span>' : '',
      id === uid ? '<span class="badge badge-me">あなた</span>' : '',
      byId[id] && !isOnline(m) ? '<span class="badge">接続待ち</span>' : '',
    ].join('');
    return `
      <li class="member${byId[id] && !isOnline(m) ? ' is-offline' : ''}">
        ${avatarHtml(m, 'sm')}
        <span class="member-name">${escapeHtml(m.nickname)}</span>
        ${badges}
      </li>`;
  });
  // 最低人数に届くまで空き枠を表示
  for (let i = count; i < MIN_MEMBERS; i += 1) {
    rows.push(`
      <li class="member-slot">
        <span class="avatar avatar-sm">？</span>
        <span>親カードにタッチして参加</span>
      </li>`);
  }
  $('#member-list').innerHTML = rows.join('');

  $('#member-status').textContent = count < MIN_MEMBERS
    ? `あと${MIN_MEMBERS - count}人で始められます`
    : count >= MAX_MEMBERS ? '満員です' : 'メンバーがそろいました！';

  show($('#host-panel'), isHost);
  show($('#guest-panel'), !isHost);
  document.querySelectorAll('#host-panel .mode-card').forEach((btn) => {
    btn.disabled = !ready;
  });
  $('#guest-message').textContent = ready
    ? 'ホストがモードを選ぶのを待っています'
    : 'メンバーがそろうのを待っています';

  show($('#add-dummy'), isLocalMode && isHost && count < MAX_MEMBERS);
}

function handleRoomChange(room) {
  if (roomState.leaving) return;
  if (!room || room.status === 'finished') {
    toast('このルームは終了しました');
    location.replace('lobby.html');
    return;
  }
  if (!room.memberIds.includes(uid)) {
    toast('ルームから退出しました');
    location.replace('lobby.html');
    return;
  }
  roomState.room = room;
  // ホストがモードを選んだら、全員そろってゲーム画面へ
  if (room.status === 'playing' && MODE_PAGES[room.mode]) {
    location.replace(`${MODE_PAGES[room.mode]}?room=${encodeURIComponent(room.id)}`);
    return;
  }
  renderRoom();
}

async function initRoom(roomId) {
  showView('room');

  const room = await store.getRoom(roomId);
  if (!room || room.status === 'finished' || !room.memberIds.includes(uid)) {
    // URL だけで直接開いた場合は入室していないので、ホームへ戻す
    toast('このルームには入室していません');
    location.replace('lobby.html');
    return;
  }

  await store.watchRoom(roomId, handleRoomChange);
  await store.watchMembers(roomId, (members) => {
    roomState.members = members;
    renderRoom();
  });

  const beat = () => store.heartbeat(roomId, uid).catch(console.warn);
  beat();
  setInterval(beat, HEARTBEAT_MS);
  // オフライン表示を更新するため、定期的に再描画
  setInterval(renderRoom, 10 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') beat();
  });

  $('#host-panel').addEventListener('click', async (e) => {
    const btn = e.target.closest('.mode-card');
    if (!btn || btn.disabled) return;
    document.querySelectorAll('#host-panel .mode-card').forEach((b) => { b.disabled = true; });
    try {
      await store.startMode(roomId, btn.dataset.mode);
    } catch (err) {
      toast(errorMessage(err), 'error');
      renderRoom();
    }
  });

  $('#room-leave').addEventListener('click', async () => {
    if (!window.confirm('ルームから退出しますか？')) return;
    roomState.leaving = true;
    try {
      await store.leaveRoom(roomId, uid);
      location.replace('lobby.html');
    } catch (err) {
      roomState.leaving = false;
      toast(errorMessage(err), 'error');
    }
  });

  $('#add-dummy').addEventListener('click', async () => {
    try {
      await store.addDummyMember(roomId);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });
}

/* ------------------------------------------------------------------ */

async function main() {
  showLocalBanner();
  uid = await signIn();
  const player = await store.getPlayer(uid);
  if (!player?.nickname) {
    location.replace(`profile.html?next=${encodeURIComponent(`lobby.html${location.search}`)}`);
    return;
  }
  const roomId = params.get('room');
  if (roomId) await initRoom(roomId);
  else await initHome();
}

main().catch(showFatal);
