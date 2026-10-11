// Firestore の読み書きをまとめたデータ層。
// 画面側は store.xxx() だけを呼び、Firebase とローカルモードの違いを意識しなくて済むようにしています。
import { getFirebase, isLocalMode, randomId } from './firebase.js';
import { SURVEY } from './survey.js';

export const MIN_MEMBERS = 3;
export const MAX_MEMBERS = 6;
export const ONLINE_TIMEOUT_MS = 75 * 1000;

export class GameError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// Firestore の Timestamp / Date / ミリ秒 をミリ秒に揃える
export function toMillis(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return 0;
}

export function countAnswered(survey = {}) {
  return SURVEY.filter((q) => survey[q.id] === 'A' || survey[q.id] === 'B').length;
}

function memberDoc(profile, now) {
  return {
    nickname: profile.nickname,
    color: profile.color,
    score: 0,
    joinedAt: now,
    lastSeenAt: now,
  };
}

function newRoomDoc({ tableCardId, code, uid, now }) {
  return {
    tableCardId: tableCardId || null,
    code,
    hostId: uid,
    memberIds: [uid],
    status: 'lobby',
    mode: null,
    currentRoundId: null,
    roundNo: 0,
    turnOrder: [],
    turnIndex: 0,
    usedTopicRefs: [],
    createdAt: now,
  };
}

function randomCode() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function deepMerge(target, src) {
  const out = { ...(target || {}) };
  Object.entries(src).forEach(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Firebase（Firestore）実装                                           */
/* ------------------------------------------------------------------ */
const firebaseStore = {
  async getPlayer(uid) {
    const { db, fs } = await getFirebase();
    const snap = await fs.getDoc(fs.doc(db, 'players', uid));
    return snap.exists() ? { id: uid, ...snap.data() } : null;
  },

  async savePlayer(uid, data) {
    const { db, fs } = await getFirebase();
    const ref = fs.doc(db, 'players', uid);
    const snap = await fs.getDoc(ref);
    const payload = { ...data, updatedAt: fs.serverTimestamp() };
    if (!snap.exists()) {
      payload.createdAt = fs.serverTimestamp();
      payload.cardId = data.cardId ?? null;
      payload.currentRoomId = data.currentRoomId ?? null;
      payload.currentDuelId = data.currentDuelId ?? null;
    }
    await fs.setDoc(ref, payload, { merge: true });
  },

  async watchPlayer(uid, cb) {
    const { db, fs } = await getFirebase();
    return fs.onSnapshot(fs.doc(db, 'players', uid), (snap) => {
      cb(snap.exists() ? { id: uid, ...snap.data() } : null);
    });
  },

  // 個人カードをタッチしたとき。持ち主がいなければタッチした人のカードにする。
  async openPlayerCard(cardId, uid) {
    const { db, fs } = await getFirebase();
    const cardRef = fs.doc(db, 'cards', cardId);
    const result = await fs.runTransaction(db, async (tx) => {
      const snap = await tx.get(cardRef);
      const card = snap.exists() ? snap.data() : null;
      if (card && card.kind === 'table') throw new GameError('NOT_PLAYER_CARD');
      if (card && card.ownerId) return { ownerId: card.ownerId, claimed: false };
      tx.set(cardRef, { kind: 'player', ownerId: uid, roomId: null, label: card?.label || cardId }, { merge: true });
      return { ownerId: uid, claimed: true };
    });
    if (result.claimed) await this.savePlayer(uid, { cardId });
    return result;
  },

  async releaseCard(cardId, uid) {
    const { db, fs } = await getFirebase();
    const cardRef = fs.doc(db, 'cards', cardId);
    await fs.runTransaction(db, async (tx) => {
      const snap = await tx.get(cardRef);
      if (snap.exists() && snap.data().ownerId === uid) tx.update(cardRef, { ownerId: null });
    });
    await this.savePlayer(uid, { cardId: null });
  },

  async findActiveRoomByCode(code) {
    const { db, fs } = await getFirebase();
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'rooms'), fs.where('code', '==', code)));
    const rooms = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((r) => r.status !== 'finished')
      .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
    return rooms[0] || null;
  },

  async uniqueCode() {
    for (let i = 0; i < 8; i += 1) {
      const code = randomCode();
      // eslint-disable-next-line no-await-in-loop
      if (!(await this.findActiveRoomByCode(code))) return code;
    }
    return randomCode();
  },

  // 親カードをタッチしたとき。カードに紐づく進行中ルームに入室、なければ新しく作る。
  async joinTableRoom(tableCardId, uid, profile) {
    const { db, fs } = await getFirebase();
    const code = await this.uniqueCode();
    const now = fs.serverTimestamp();
    const cardRef = fs.doc(db, 'cards', tableCardId);
    const roomId = await fs.runTransaction(db, async (tx) => {
      const cardSnap = await tx.get(cardRef);
      const card = cardSnap.exists() ? cardSnap.data() : null;
      if (card && card.kind === 'player') throw new GameError('NOT_TABLE_CARD');
      if (card && card.roomId) {
        const roomRef = fs.doc(db, 'rooms', card.roomId);
        const roomSnap = await tx.get(roomRef);
        if (roomSnap.exists() && roomSnap.data().status !== 'finished') {
          const room = roomSnap.data();
          if (room.memberIds.includes(uid)) return roomRef.id;
          if (room.memberIds.length >= MAX_MEMBERS) throw new GameError('ROOM_FULL');
          tx.update(roomRef, { memberIds: fs.arrayUnion(uid) });
          tx.set(fs.doc(db, 'rooms', roomRef.id, 'members', uid), memberDoc(profile, now));
          return roomRef.id;
        }
      }
      const roomRef = fs.doc(fs.collection(db, 'rooms'));
      tx.set(roomRef, newRoomDoc({ tableCardId, code, uid, now }));
      tx.set(fs.doc(db, 'rooms', roomRef.id, 'members', uid), memberDoc(profile, now));
      tx.set(cardRef, { kind: 'table', ownerId: null, roomId: roomRef.id, label: card?.label || tableCardId }, { merge: true });
      return roomRef.id;
    });
    await this.savePlayer(uid, { currentRoomId: roomId });
    return roomId;
  },

  // NFCが使えない人向け：4桁のルームコードで入室
  async joinRoomByCode(code, uid, profile) {
    const { db, fs } = await getFirebase();
    const found = await this.findActiveRoomByCode(code);
    if (!found) throw new GameError('ROOM_NOT_FOUND');
    const roomRef = fs.doc(db, 'rooms', found.id);
    const now = fs.serverTimestamp();
    await fs.runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists() || snap.data().status === 'finished') throw new GameError('ROOM_NOT_FOUND');
      const room = snap.data();
      if (room.memberIds.includes(uid)) return;
      if (room.memberIds.length >= MAX_MEMBERS) throw new GameError('ROOM_FULL');
      tx.update(roomRef, { memberIds: fs.arrayUnion(uid) });
      tx.set(fs.doc(db, 'rooms', found.id, 'members', uid), memberDoc(profile, now));
    });
    await this.savePlayer(uid, { currentRoomId: found.id });
    return found.id;
  },

  async getRoom(roomId) {
    const { db, fs } = await getFirebase();
    const snap = await fs.getDoc(fs.doc(db, 'rooms', roomId));
    return snap.exists() ? { id: roomId, ...snap.data() } : null;
  },

  async watchRoom(roomId, cb) {
    const { db, fs } = await getFirebase();
    return fs.onSnapshot(fs.doc(db, 'rooms', roomId), (snap) => {
      cb(snap.exists() ? { id: roomId, ...snap.data() } : null);
    });
  },

  async watchMembers(roomId, cb) {
    const { db, fs } = await getFirebase();
    const q = fs.query(fs.collection(db, 'rooms', roomId, 'members'), fs.orderBy('joinedAt'));
    return fs.onSnapshot(q, (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  },

  async heartbeat(roomId, uid) {
    const { db, fs } = await getFirebase();
    await fs.updateDoc(fs.doc(db, 'rooms', roomId, 'members', uid), { lastSeenAt: fs.serverTimestamp() });
  },

  async leaveRoom(roomId, uid) {
    const { db, fs } = await getFirebase();
    const roomRef = fs.doc(db, 'rooms', roomId);
    const memberRef = fs.doc(db, 'rooms', roomId, 'members', uid);
    await fs.runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) return;
      const room = snap.data();
      const rest = room.memberIds.filter((id) => id !== uid);
      const update = { memberIds: rest };
      if (room.hostId === uid) {
        if (rest.length) update.hostId = rest[0];
        else update.status = 'finished';
      }
      tx.update(roomRef, update);
      tx.delete(memberRef);
    });
    await this.savePlayer(uid, { currentRoomId: null });
  },

  // ホストがモードを選んでゲーム開始
  async startMode(roomId, mode) {
    const { db, fs } = await getFirebase();
    const roomRef = fs.doc(db, 'rooms', roomId);
    await fs.runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) throw new GameError('ROOM_NOT_FOUND');
      const room = snap.data();
      if (room.memberIds.length < MIN_MEMBERS) throw new GameError('NOT_ENOUGH_MEMBERS');
      tx.update(roomRef, {
        status: 'playing',
        mode,
        turnOrder: shuffle(room.memberIds),
        turnIndex: 0,
        roundNo: 0,
        currentRoundId: null,
      });
    });
  },

  async addDummyMember() {
    throw new GameError('LOCAL_ONLY');
  },
};

/* ------------------------------------------------------------------ */
/* ローカルモード実装（localStorage・1台で画面確認用）                   */
/* ------------------------------------------------------------------ */
const LOCAL_DB_KEY = 'nfclove:db';
const localListeners = new Set();

function localEmpty() {
  return { players: {}, cards: {}, rooms: {}, members: {} };
}
function localLoad() {
  try {
    return { ...localEmpty(), ...(JSON.parse(localStorage.getItem(LOCAL_DB_KEY)) || {}) };
  } catch (_) {
    return localEmpty();
  }
}
function localSave(db) {
  localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(db));
  localListeners.forEach((fn) => fn());
}
function localSubscribe(fn) {
  localListeners.add(fn);
  fn();
  return () => localListeners.delete(fn);
}
window.addEventListener('storage', (e) => {
  if (e.key === LOCAL_DB_KEY) localListeners.forEach((fn) => fn());
});

function localAddMember(db, roomId, uid, profile) {
  const room = db.rooms[roomId];
  if (room.memberIds.includes(uid)) return;
  if (room.memberIds.length >= MAX_MEMBERS) throw new GameError('ROOM_FULL');
  room.memberIds.push(uid);
  db.members[roomId] = db.members[roomId] || {};
  db.members[roomId][uid] = memberDoc(profile, Date.now());
}

function localFindActiveRoom(db, code) {
  return Object.entries(db.rooms)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => r.code === code && r.status !== 'finished')
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

const DUMMY_NAMES = ['ミナ', 'ソウタ', 'ユイ', 'ハルト', 'サキ'];
const DUMMY_COLORS = ['#FF8FA3', '#6C9BFF', '#FFB86B', '#5CC9A7', '#B48CFF'];

const localStore = {
  async getPlayer(uid) {
    const p = localLoad().players[uid];
    return p ? { id: uid, ...p } : null;
  },

  async savePlayer(uid, data) {
    const db = localLoad();
    const base = db.players[uid] || {
      createdAt: Date.now(),
      cardId: null,
      currentRoomId: null,
      currentDuelId: null,
    };
    db.players[uid] = { ...deepMerge(base, data), updatedAt: Date.now() };
    localSave(db);
  },

  async watchPlayer(uid, cb) {
    return localSubscribe(() => {
      const p = localLoad().players[uid];
      cb(p ? { id: uid, ...p } : null);
    });
  },

  async openPlayerCard(cardId, uid) {
    const db = localLoad();
    const card = db.cards[cardId];
    if (card && card.kind === 'table') throw new GameError('NOT_PLAYER_CARD');
    if (card && card.ownerId) return { ownerId: card.ownerId, claimed: false };
    db.cards[cardId] = { kind: 'player', ownerId: uid, roomId: null, label: card?.label || cardId };
    localSave(db);
    await this.savePlayer(uid, { cardId });
    return { ownerId: uid, claimed: true };
  },

  async releaseCard(cardId, uid) {
    const db = localLoad();
    if (db.cards[cardId]?.ownerId === uid) db.cards[cardId].ownerId = null;
    localSave(db);
    await this.savePlayer(uid, { cardId: null });
  },

  async joinTableRoom(tableCardId, uid, profile) {
    const db = localLoad();
    const card = db.cards[tableCardId];
    if (card && card.kind === 'player') throw new GameError('NOT_TABLE_CARD');
    let roomId = card?.roomId;
    if (roomId && db.rooms[roomId] && db.rooms[roomId].status !== 'finished') {
      localAddMember(db, roomId, uid, profile);
    } else {
      roomId = randomId();
      let code = randomCode();
      while (localFindActiveRoom(db, code)) code = randomCode();
      db.rooms[roomId] = newRoomDoc({ tableCardId, code, uid, now: Date.now() });
      db.members[roomId] = { [uid]: memberDoc(profile, Date.now()) };
      db.cards[tableCardId] = { kind: 'table', ownerId: null, roomId, label: card?.label || tableCardId };
    }
    localSave(db);
    await this.savePlayer(uid, { currentRoomId: roomId });
    return roomId;
  },

  async joinRoomByCode(code, uid, profile) {
    const db = localLoad();
    const found = localFindActiveRoom(db, code);
    if (!found) throw new GameError('ROOM_NOT_FOUND');
    localAddMember(db, found.id, uid, profile);
    localSave(db);
    await this.savePlayer(uid, { currentRoomId: found.id });
    return found.id;
  },

  async getRoom(roomId) {
    const r = localLoad().rooms[roomId];
    return r ? { id: roomId, ...r } : null;
  },

  async watchRoom(roomId, cb) {
    return localSubscribe(() => {
      const r = localLoad().rooms[roomId];
      cb(r ? { id: roomId, ...r } : null);
    });
  },

  async watchMembers(roomId, cb) {
    return localSubscribe(() => {
      const members = localLoad().members[roomId] || {};
      cb(Object.entries(members)
        .map(([id, m]) => ({ id, ...m }))
        .sort((a, b) => a.joinedAt - b.joinedAt));
    });
  },

  async heartbeat(roomId, uid) {
    const db = localLoad();
    const m = db.members[roomId]?.[uid];
    if (!m) return;
    m.lastSeenAt = Date.now();
    localSave(db);
  },

  async leaveRoom(roomId, uid) {
    const db = localLoad();
    const room = db.rooms[roomId];
    if (room) {
      room.memberIds = room.memberIds.filter((id) => id !== uid);
      if (room.hostId === uid) {
        // テスト用メンバーだけが残る場合もルームを終了する
        const humans = room.memberIds.filter((id) => !db.members[roomId]?.[id]?.isDummy);
        if (humans.length) room.hostId = humans[0];
        else room.status = 'finished';
      }
      if (db.members[roomId]) delete db.members[roomId][uid];
      localSave(db);
    }
    await this.savePlayer(uid, { currentRoomId: null });
  },

  async startMode(roomId, mode) {
    const db = localLoad();
    const room = db.rooms[roomId];
    if (!room) throw new GameError('ROOM_NOT_FOUND');
    if (room.memberIds.length < MIN_MEMBERS) throw new GameError('NOT_ENOUGH_MEMBERS');
    Object.assign(room, {
      status: 'playing',
      mode,
      turnOrder: shuffle(room.memberIds),
      turnIndex: 0,
      roundNo: 0,
      currentRoundId: null,
    });
    localSave(db);
  },

  // ローカルモード専用：テスト用の仮メンバーを追加（アンケートはランダム回答）
  async addDummyMember(roomId) {
    const db = localLoad();
    const room = db.rooms[roomId];
    if (!room) throw new GameError('ROOM_NOT_FOUND');
    const index = room.memberIds.length - 1;
    const dummyId = `dummy-${randomId(8)}`;
    const profile = {
      nickname: `${DUMMY_NAMES[index % DUMMY_NAMES.length]}（テスト）`,
      color: DUMMY_COLORS[index % DUMMY_COLORS.length],
    };
    const survey = {};
    SURVEY.forEach((q) => {
      const r = Math.random();
      survey[q.id] = r < 0.4 ? 'A' : r < 0.8 ? 'B' : null;
    });
    db.players[dummyId] = {
      ...profile, survey, answeredCount: countAnswered(survey), cardId: null,
      currentRoomId: roomId, currentDuelId: null, createdAt: Date.now(), updatedAt: Date.now(),
    };
    localAddMember(db, roomId, dummyId, profile);
    db.members[roomId][dummyId].isDummy = true;
    localSave(db);
  },
};

export const store = isLocalMode ? localStore : firebaseStore;
