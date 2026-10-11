// S00 エントリー（ルーター）
//   ?card=P-xxxx   個人カード：自分のカードなら登録してホームへ、他人のカードなら1対1モードへ
//   ?table=T-xxxx  親カード：複数人ルームへ入室
//   ?room=1234     ルームコードで入室（NFC非対応端末用）
//   パラメータなし  ホーム（待機画面）へ
import { signIn } from './firebase.js';
import { store } from './store.js';
import { $, showFatal, showLocalBanner } from './ui.js';

const params = new URLSearchParams(location.search);

function setMessage(title, message) {
  $('#entry-title').textContent = title;
  $('#entry-message').textContent = message;
}

async function main() {
  showLocalBanner();
  const uid = await signIn();
  const player = await store.getPlayer(uid);

  // 初めての人はプロフィール登録とアンケートを先に済ませ、終わったらこのURLに戻ってくる
  if (!player?.nickname) {
    const next = `index.html${location.search}`;
    location.replace(`profile.html?next=${encodeURIComponent(next)}`);
    return;
  }

  const cardId = params.get('card');
  const tableId = params.get('table');
  const roomCode = params.get('room');

  if (cardId) {
    setMessage('カードを確認中…', '個人カードを読み取りました');
    const { ownerId, claimed } = await store.openPlayerCard(cardId, uid);
    if (ownerId === uid) {
      location.replace(`lobby.html${claimed ? '?linked=1' : ''}`);
    } else {
      // 他人のカード → 1対1モード（ワード・スナイパー）の対戦申し込み（ステップ3で実装）
      location.replace(`sniper.html?opponent=${encodeURIComponent(ownerId)}`);
    }
    return;
  }

  if (tableId) {
    setMessage('ルームに入室中…', '親カードを読み取りました');
    const roomId = await store.joinTableRoom(tableId, uid, player);
    location.replace(`lobby.html?room=${encodeURIComponent(roomId)}`);
    return;
  }

  if (roomCode) {
    setMessage('ルームに入室中…', `ルームコード ${roomCode}`);
    const roomId = await store.joinRoomByCode(roomCode, uid, player);
    location.replace(`lobby.html?room=${encodeURIComponent(roomId)}`);
    return;
  }

  location.replace('lobby.html');
}

main().catch(showFatal);
