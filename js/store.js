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
/* 1対1モード（ワード・スナイパー・時限爆弾解除）の共通ロジック          */
/* ------------------------------------------------------------------ */
// ターン制：先攻・後攻が交互に攻撃する。1ターンの秒数と、1人あたりの攻撃ターン数
export const TURN_SECONDS = 90;
export const TURNS_PER_PLAYER = 1;
export const TOTAL_TURNS = TURNS_PER_PLAYER * 2;

// turnIndex 番目のターンで攻撃する人
export function attackerOf(duel, turnIndex = duel.turnIndex) {
  return duel.turnOrder?.[turnIndex % 2] || null;
}

// 書き込み時にサーバー時刻（ローカルモードでは端末時刻）へ置き換える目印
export const SERVER_TIME = '__server_time__';

/* ---------- 時限爆弾解除（ディフューズ・トーク） ---------- */
// 制限時間と、解除コードの桁数（＝問題の数）。起爆の合図からカウントダウンまでの猶予
export const DEFUSE_SECONDS = 60;
export const DEFUSE_DIGITS = 2;
export const DEFUSE_COUNTDOWN_MS = 3000;
// 準備のまま動きがない対戦は、次のタッチで作り直す
const DEFUSE_STALE_MS = 10 * 60 * 1000;

/* ---------- ステータス・ベット（初対面の印象ギャンブル） ---------- */
// 最初の持ちコイン、1対1のラウンド数、賭け金のボタン（ALL IN は別）
export const BET_START_COINS = 1000;
export const BET_DUEL_TURNS = 3;
export const BET_STAKES = [100, 300, 500];

// 1対1のモード（mode がない対戦はワード・スナイパー）
export const DUEL_MODES = ['sniper', 'defuse', 'bet'];
const DUEL_PAGES = { sniper: 'sniper.html', defuse: 'defuse.html', bet: 'bet.html' };
export function duelModeOf(duel) {
  return DUEL_MODES.includes(duel?.mode) ? duel.mode : 'sniper';
}
export function duelPage(mode) {
  return DUEL_PAGES[mode] || DUEL_PAGES.sniper;
}

// 同じ2人の対戦は常に同じドキュメントを使う（どちらがタッチしても合流できる）
export function duelIdFor(a, b) {
  return `pair_${[a, b].sort().join('_')}`;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}

// SERVER_TIME の目印をサーバー時刻に置き換える（入れ子のオブジェクトの中も。配列の中は対象外）
function resolveTime(data, timeValue) {
  const out = {};
  Object.entries(data).forEach(([k, v]) => {
    if (v === SERVER_TIME) out[k] = timeValue;
    else if (isPlainObject(v)) out[k] = resolveTime(v, timeValue);
    else out[k] = v;
  });
  return out;
}

// "a.b.c" のような区切りのキーで、入れ子のオブジェクトに値を入れる（ローカルモード用）
function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  keys.slice(0, -1).forEach((k) => {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  });
  cur[keys[keys.length - 1]] = value;
}

// 時限爆弾解除の新しい対戦（ラウンドごとに作り直す）
function newDefuseDoc(duel, uid, opponentId, ids, players) {
  return {
    mode: 'defuse',
    playerIds: ids,
    players,
    status: 'waiting',
    round: (duel?.round || 0) + 1,
    joined: { [uid]: true, [opponentId]: false },
    startedAt: null,
    // arming：解除コードの準備 → live：60秒の本番
    phase: 'arming',
    timeSec: DEFUSE_SECONDS,
    codes: {}, // uid → その人の解除コードになる問題（相手の画面に出る）
    keys: {}, // uid → その人の答え（相手の入力と照合する）
    armed: { [uid]: false, [opponentId]: false },
    liveAt: null,
    inputs: {}, // uid → 解除ボタンを押したときの入力
    defused: {}, // uid → 解除に成功したか
    outcome: null, // complete / exploded
    reason: null, // timeout / wrong
    failedBy: null,
    clearMs: null,
    createdAt: duel?.createdAt || SERVER_TIME,
    updatedAt: SERVER_TIME,
  };
}

// ステータス・ベット（1対1）の新しい対戦。3ラウンドとも、2人がお互いの問いに賭ける。
//   turns   … tN → { targets: [uid], questions: { uid: 問い }, needsStance: { uid: true/false } }
//   answers … tN → { uid: 'A' / 'B' }（アンケートの答え、または本人がこっそり選んだ答え）
//   bets    … tN → { 賭けた人の uid: { target, pick, amount } }
function newBetDoc(duel, uid, opponentId, ids, players) {
  return {
    mode: 'bet',
    playerIds: ids,
    players,
    status: 'waiting',
    round: (duel?.round || 0) + 1,
    joined: { [uid]: true, [opponentId]: false },
    startedAt: null,
    totalTurns: BET_DUEL_TURNS,
    turnIndex: -1,
    phase: null,
    phaseAt: null,
    turns: {},
    answers: {},
    bets: {},
    ready: {}, // 'start'（開始画面）・tN（お題提示）→ { uid: true }
    createdAt: duel?.createdAt || SERVER_TIME,
    updatedAt: SERVER_TIME,
  };
}

// タッチしたときの対戦ドキュメントの変化を決める。
// 終わった対戦なら新しいラウンドを作り、待機中なら自分を参加済みにして、2人そろえば開始する。
// ワード・スナイパーは先攻の「準備」（turnPhase: 'ready'）から、時限爆弾解除はコードの準備（phase: 'arming'）から始まる。
// mode が今の待機中の対戦と違うときは、選び直したモードで申し込み直す。
function duelEnterPatch(duel, uid, opponentId, me, opponent, mode = 'sniper') {
  const ids = [uid, opponentId].sort();
  const players = {
    [uid]: { nickname: me.nickname, color: me.color },
    [opponentId]: { nickname: opponent.nickname, color: opponent.color },
  };
  const current = duel ? duelModeOf(duel) : null;
  // ターン制になる前に作られた対戦（turnOrder がない）は、作り直す
  const legacy = duel && current === 'sniper' && !duel.turnOrder;
  const otherMode = duel && duel.status === 'waiting' && current !== mode;
  const stale = duel && (current === 'defuse' || current === 'bet') && duel.status === 'playing'
    && Date.now() - toMillis(duel.updatedAt) > DEFUSE_STALE_MS;
  if (!duel || legacy || otherMode || stale || duel.status === 'finished' || duel.status === 'cancelled') {
    if (mode === 'defuse') {
      return { mode: 'set', data: newDefuseDoc(duel, uid, opponentId, ids, players) };
    }
    if (mode === 'bet') {
      return { mode: 'set', data: newBetDoc(duel, uid, opponentId, ids, players) };
    }
    const turnOrder = Math.random() < 0.5 ? [uid, opponentId] : [opponentId, uid];
    return {
      mode: 'set',
      data: {
        mode: 'sniper',
        playerIds: ids,
        players,
        status: 'waiting',
        round: (duel?.round || 0) + 1,
        joined: { [uid]: true, [opponentId]: false },
        startedAt: null,
        turnOrder,
        turnIndex: 0,
        turnPhase: 'ready',
        turnStartedAt: null,
        turnSec: TURN_SECONDS,
        totalTurns: TOTAL_TURNS,
        scores: { [uid]: 0, [opponentId]: 0 },
        history: [],
        revealed: {},
        createdAt: duel?.createdAt || SERVER_TIME,
        updatedAt: SERVER_TIME,
      },
    };
  }
  if (duel.status === 'waiting' && !duel.joined?.[uid]) {
    const joined = { ...duel.joined, [uid]: true };
    const ready = ids.every((id) => joined[id]);
    return {
      mode: 'update',
      data: {
        joined,
        players,
        ...(ready ? { status: 'playing', startedAt: SERVER_TIME } : {}),
        updatedAt: SERVER_TIME,
      },
    };
  }
  return null;
}

function randomSurvey() {
  const survey = {};
  SURVEY.forEach((q) => {
    const r = Math.random();
    survey[q.id] = r < 0.4 ? 'A' : r < 0.8 ? 'B' : null;
  });
  return survey;
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
      cb(snap.exists() ? { id: roomId, ...snap.data({ serverTimestamps: 'estimate' }) } : null);
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
        bet: null,
      });
    });
  },

  // ホストがルームの進行を書き込む。fn(現在のルーム) が返した差分をトランザクションで書き込む（null なら何もしない）
  async updateRoom(roomId, fn) {
    const { db, fs } = await getFirebase();
    const ref = fs.doc(db, 'rooms', roomId);
    return fs.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new GameError('ROOM_NOT_FOUND');
      const patch = fn({ id: roomId, ...snap.data() });
      if (!patch) return false;
      tx.update(ref, resolveTime(patch, fs.serverTimestamp()));
      return true;
    });
  },

  // 自分のメンバー情報に書き込む。キーは "a.b.c" の形で入れ子の場所を指定できる
  async updateMember(roomId, uid, patch) {
    const { db, fs } = await getFirebase();
    await fs.updateDoc(fs.doc(db, 'rooms', roomId, 'members', uid), resolveTime(patch, fs.serverTimestamp()));
  },

  /* ---------- 1対1モード ---------- */

  // 相手の個人カードをタッチしたとき（または挑戦を受けたとき）に呼ぶ。対戦IDを返す。
  async enterDuel(uid, opponentId, me, mode = 'sniper') {
    const { db, fs } = await getFirebase();
    const oppSnap = await fs.getDoc(fs.doc(db, 'players', opponentId));
    if (!oppSnap.exists()) throw new GameError('PLAYER_NOT_FOUND');
    const duelId = duelIdFor(uid, opponentId);
    const ref = fs.doc(db, 'duels', duelId);
    await fs.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const patch = duelEnterPatch(snap.exists() ? snap.data() : null, uid, opponentId, me, oppSnap.data(), mode);
      if (!patch) return;
      const data = resolveTime(patch.data, fs.serverTimestamp());
      if (patch.mode === 'set') tx.set(ref, data);
      else tx.update(ref, data);
    });
    return duelId;
  },

  async getDuel(duelId) {
    const { db, fs } = await getFirebase();
    const snap = await fs.getDoc(fs.doc(db, 'duels', duelId));
    return snap.exists() ? { id: duelId, ...snap.data({ serverTimestamps: 'estimate' }) } : null;
  },

  async watchDuel(duelId, cb) {
    const { db, fs } = await getFirebase();
    return fs.onSnapshot(fs.doc(db, 'duels', duelId), (snap) => {
      cb(snap.exists() ? { id: duelId, ...snap.data({ serverTimestamps: 'estimate' }) } : null);
    }, (err) => cb(null, err));
  },

  // fn(現在の対戦) が返した差分をトランザクションで書き込む（null なら何もしない）
  async updateDuel(duelId, fn) {
    const { db, fs } = await getFirebase();
    const ref = fs.doc(db, 'duels', duelId);
    return fs.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new GameError('DUEL_NOT_FOUND');
      const patch = fn({ id: duelId, ...snap.data() });
      if (!patch) return false;
      tx.update(ref, resolveTime({ ...patch, updatedAt: SERVER_TIME }, fs.serverTimestamp()));
      return true;
    });
  },

  // 自分宛ての挑戦（相手が自分のカードをタッチして待っている対戦）を監視
  async watchIncomingDuels(uid, cb) {
    const { db, fs } = await getFirebase();
    const q = fs.query(fs.collection(db, 'duels'), fs.where('playerIds', 'array-contains', uid));
    return fs.onSnapshot(q, (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })));
    }, (err) => console.warn(err));
  },

  // ターゲットワード（本人しか読めない）
  async getDuelSecret(duelId, uid) {
    const { db, fs } = await getFirebase();
    const snap = await fs.getDoc(fs.doc(db, 'duels', duelId, 'secrets', uid));
    return snap.exists() ? snap.data() : null;
  },

  async setDuelSecret(duelId, uid, data) {
    const { db, fs } = await getFirebase();
    await fs.setDoc(fs.doc(db, 'duels', duelId, 'secrets', uid), data);
  },

  async createDummyOpponent() {
    throw new GameError('LOCAL_ONLY');
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
  return {
    players: {}, cards: {}, rooms: {}, members: {}, duels: {}, duelSecrets: {},
  };
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

// テスト用の仮プレイヤーを db に追加してIDを返す（アンケートはランダム回答）
function localCreateDummy(db, index, roomId) {
  const dummyId = `dummy-${randomId(8)}`;
  const survey = randomSurvey();
  db.players[dummyId] = {
    nickname: `${DUMMY_NAMES[index % DUMMY_NAMES.length]}（テスト）`,
    color: DUMMY_COLORS[index % DUMMY_COLORS.length],
    survey,
    answeredCount: countAnswered(survey),
    isDummy: true,
    cardId: null,
    currentRoomId: roomId,
    currentDuelId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return dummyId;
}

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
      bet: null,
    });
    localSave(db);
  },

  async updateRoom(roomId, fn) {
    const db = localLoad();
    const room = db.rooms[roomId];
    if (!room) throw new GameError('ROOM_NOT_FOUND');
    const patch = fn({ id: roomId, ...room });
    if (!patch) return false;
    Object.assign(room, resolveTime(patch, Date.now()));
    localSave(db);
    return true;
  },

  async updateMember(roomId, uid, patch) {
    const db = localLoad();
    const member = db.members[roomId]?.[uid];
    if (!member) throw new GameError('ROOM_NOT_FOUND');
    Object.entries(resolveTime(patch, Date.now())).forEach(([path, value]) => setPath(member, path, value));
    localSave(db);
  },

  // ローカルモード専用：テスト用の仮メンバーを追加（アンケートはランダム回答）
  async addDummyMember(roomId) {
    const db = localLoad();
    const room = db.rooms[roomId];
    if (!room) throw new GameError('ROOM_NOT_FOUND');
    const dummyId = localCreateDummy(db, room.memberIds.length - 1, roomId);
    localAddMember(db, roomId, dummyId, db.players[dummyId]);
    db.members[roomId][dummyId].isDummy = true;
    localSave(db);
  },

  /* ---------- 1対1モード ---------- */

  async enterDuel(uid, opponentId, me, mode = 'sniper') {
    const db = localLoad();
    const opponent = db.players[opponentId];
    if (!opponent) throw new GameError('PLAYER_NOT_FOUND');
    const duelId = duelIdFor(uid, opponentId);
    const patch = duelEnterPatch(db.duels[duelId] || null, uid, opponentId, me, opponent, mode);
    if (patch) {
      const data = resolveTime(patch.data, Date.now());
      db.duels[duelId] = patch.mode === 'set' ? data : { ...db.duels[duelId], ...data };
      // テスト相手はすぐに参加したことにする
      if (opponent.isDummy && db.duels[duelId].status === 'waiting') {
        Object.assign(db.duels[duelId], {
          joined: { ...db.duels[duelId].joined, [opponentId]: true },
          status: 'playing',
          startedAt: Date.now(),
        });
      }
      localSave(db);
    }
    return duelId;
  },

  async getDuel(duelId) {
    const d = localLoad().duels[duelId];
    return d ? { id: duelId, ...d } : null;
  },

  async watchDuel(duelId, cb) {
    return localSubscribe(() => {
      const d = localLoad().duels[duelId];
      cb(d ? { id: duelId, ...d } : null);
    });
  },

  async updateDuel(duelId, fn) {
    const db = localLoad();
    const duel = db.duels[duelId];
    if (!duel) throw new GameError('DUEL_NOT_FOUND');
    const patch = fn({ id: duelId, ...duel });
    if (!patch) return false;
    db.duels[duelId] = { ...duel, ...resolveTime({ ...patch, updatedAt: SERVER_TIME }, Date.now()) };
    localSave(db);
    return true;
  },

  async watchIncomingDuels(uid, cb) {
    return localSubscribe(() => {
      const { duels } = localLoad();
      cb(Object.entries(duels)
        .map(([id, d]) => ({ id, ...d }))
        .filter((d) => d.playerIds.includes(uid)));
    });
  },

  async getDuelSecret(duelId, uid) {
    return localLoad().duelSecrets[`${duelId}/${uid}`] || null;
  },

  async setDuelSecret(duelId, uid, data) {
    const db = localLoad();
    db.duelSecrets[`${duelId}/${uid}`] = data;
    localSave(db);
  },

  // ローカルモード専用：1対1のテスト相手を作り、そのIDを返す
  async createDummyOpponent() {
    const db = localLoad();
    const index = Object.values(db.players).filter((p) => p.isDummy).length;
    const dummyId = localCreateDummy(db, index, null);
    localSave(db);
    return dummyId;
  },
};

export const store = isLocalMode ? localStore : firebaseStore;
