// 画面共通の小さな部品（DOM取得、アバター、トースト、エラー表示）
import { isLocalMode } from './firebase.js';

export const COLORS = ['#FF5C8A', '#FF8FA3', '#FFB86B', '#F7D046', '#5CC9A7', '#4FB3E8', '#6C9BFF', '#B48CFF'];

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function show(el, visible = true) {
  if (el) el.hidden = !visible;
}

export function avatarHtml(player, size = 'md') {
  const name = player?.nickname || '？';
  const initial = Array.from(name)[0];
  const color = player?.color || COLORS[0];
  return `<span class="avatar avatar-${size}" style="--avatar-color:${escapeHtml(color)}" aria-hidden="true">${escapeHtml(initial)}</span>`;
}

let toastTimer = null;
export function toast(message, type = 'info') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.dataset.type = type;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2600);
}

const ERROR_MESSAGES = {
  ROOM_FULL: 'このルームは満員です（最大6人）。',
  ROOM_NOT_FOUND: 'ルームが見つかりません。コードを確かめるか、親カードをタッチしてください。',
  NOT_TABLE_CARD: 'これは個人カードです。テーブル中央の親カードをタッチしてください。',
  NOT_PLAYER_CARD: 'これは親カードです。相手の個人カードをタッチしてください。',
  NOT_ENOUGH_MEMBERS: '3人以上そろうと始められます。',
  'permission-denied': 'アクセスが拒否されました。Firestore のセキュリティルールを確認してください。',
  unavailable: '通信できませんでした。電波の良い場所でもう一度お試しください。',
};

export function errorMessage(err) {
  if (!err) return 'エラーが発生しました。';
  return ERROR_MESSAGES[err.code] || err.message || 'エラーが発生しました。';
}

export function showLocalBanner() {
  if (!isLocalMode || $('.local-banner')) return;
  const el = document.createElement('div');
  el.className = 'local-banner';
  el.textContent = 'ローカルモード：この端末だけで動作しています';
  document.body.prepend(el);
}

// 画面全体を「続行できないエラー」表示に切り替える
export function showFatal(err) {
  console.error(err);
  const app = $('#app') || document.body;
  app.innerHTML = `
    <section class="screen screen-center">
      <div class="big-emoji" aria-hidden="true" style="color:var(--ink-soft)">♣</div>
      <h1 class="title">うまく開けませんでした</h1>
      <p class="muted">${escapeHtml(errorMessage(err))}</p>
      <a class="btn btn-primary btn-block" href="lobby.html">ホームへ戻る</a>
    </section>`;
}
