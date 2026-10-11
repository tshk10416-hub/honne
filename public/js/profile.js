// S01 ニックネーム登録 / S02 事前アンケート / 回答確認
//   profile.html?next=...      初回登録。完了後に next（通常は index.html?card=...）へ戻る
//   profile.html?edit=name     ニックネームと色だけ変更してホームへ
//   profile.html?edit=survey   アンケートを最初から見直してホームへ
import { signIn } from './firebase.js';
import { store, countAnswered } from './store.js';
import { SURVEY } from './survey.js';
import {
  $, COLORS, avatarHtml, escapeHtml, show, toast, errorMessage, showFatal, showLocalBanner,
} from './ui.js';

const params = new URLSearchParams(location.search);
const editMode = params.get('edit'); // 'name' | 'survey' | null

// 戻り先は同じサイト内の .html だけ許可する
function safeNext() {
  const next = params.get('next');
  if (next && /^[a-z]+\.html(\?[\w=&%.-]*)?$/i.test(next)) return next;
  return 'lobby.html';
}

const state = {
  uid: null,
  nickname: '',
  color: COLORS[Math.floor(Math.random() * COLORS.length)],
  survey: {},
  index: 0,
  busy: false,
};

const steps = ['loading', 'name', 'survey', 'done'];
function goStep(name) {
  steps.forEach((s) => show($(`#step-${s}`), s === name));
  window.scrollTo(0, 0);
}

/* ---------- S01 ニックネーム ---------- */

function renderNameAvatar() {
  $('#name-avatar').innerHTML = avatarHtml({ nickname: state.nickname || '？', color: state.color }, 'lg');
}

function renderSwatches() {
  $('#swatches').innerHTML = COLORS.map((c) => `
    <button type="button" class="swatch" role="radio" style="--swatch:${c}"
            aria-checked="${c === state.color}" aria-label="色 ${c}" data-color="${c}"></button>`).join('');
}

function updateNameForm() {
  const value = $('#nickname').value.trim();
  state.nickname = value;
  $('#nickname-count').textContent = Array.from($('#nickname').value).length;
  $('#name-submit').disabled = value.length === 0;
  renderNameAvatar();
}

function setupNameStep() {
  $('#nickname').value = state.nickname;
  renderSwatches();
  updateNameForm();
  if (editMode === 'name') {
    $('#name-submit').textContent = '保存する';
    $('.topbar-title', $('#step-name')).textContent = 'プロフィール編集';
    show($('#name-cancel'));
  }

  $('#nickname').addEventListener('input', updateNameForm);
  $('#swatches').addEventListener('click', (e) => {
    const btn = e.target.closest('.swatch');
    if (!btn) return;
    state.color = btn.dataset.color;
    renderSwatches();
    renderNameAvatar();
  });
  $('#name-cancel').addEventListener('click', () => location.replace('lobby.html'));

  $('#name-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.nickname || state.busy) return;
    state.busy = true;
    $('#name-submit').disabled = true;
    try {
      await store.savePlayer(state.uid, { nickname: state.nickname, color: state.color });
      if (editMode === 'name') {
        location.replace('lobby.html');
        return;
      }
      state.index = 0;
      renderQuestion();
      goStep('survey');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      state.busy = false;
      $('#name-submit').disabled = !state.nickname;
    }
  });
}

/* ---------- S02 アンケート ---------- */

function renderDots() {
  $('#survey-dots').innerHTML = SURVEY.map((q, i) => {
    const answered = state.survey[q.id] === 'A' || state.survey[q.id] === 'B';
    return `<span class="dot${answered ? ' is-answered' : ''}${i === state.index ? ' is-current' : ''}"></span>`;
  }).join('');
}

function renderQuestion() {
  const q = SURVEY[state.index];
  $('#q-number').textContent = `Q${q.order} / ${SURVEY.length}`;
  $('#q-text').textContent = q.text;
  $('#survey-progress').style.width = `${(state.index / SURVEY.length) * 100}%`;
  $('#choices').innerHTML = ['A', 'B'].map((key) => {
    const opt = q.options[key];
    return `
      <button type="button" class="choice" data-key="${key}" aria-pressed="${state.survey[q.id] === key}">
        <span class="choice-key">${key}</span>
        <span class="choice-label">${escapeHtml(opt.label)}</span>
        <span class="choice-emoji" aria-hidden="true">${opt.emoji}</span>
      </button>`;
  }).join('');
  $('#survey-back').style.visibility = state.index === 0 && editMode !== 'survey' && !state.cameFromDone ? 'hidden' : 'visible';
  renderDots();
}

async function saveAnswer(questionId, value) {
  state.survey[questionId] = value;
  await store.savePlayer(state.uid, {
    survey: { [questionId]: value },
    answeredCount: countAnswered(state.survey),
  });
}

function nextQuestion() {
  if (state.cameFromDone || state.index >= SURVEY.length - 1) {
    state.cameFromDone = false;
    renderDone();
    goStep('done');
    return;
  }
  state.index += 1;
  renderQuestion();
}

function setupSurveyStep() {
  $('#choices').addEventListener('click', async (e) => {
    const btn = e.target.closest('.choice');
    if (!btn || state.busy) return;
    state.busy = true;
    const q = SURVEY[state.index];
    document.querySelectorAll('#choices .choice').forEach((el) => {
      el.setAttribute('aria-pressed', String(el === btn));
    });
    try {
      await saveAnswer(q.id, btn.dataset.key);
      if (navigator.vibrate) navigator.vibrate(15);
      // 選んだことが目で分かるよう、少しだけ待ってから次へ
      await new Promise((r) => setTimeout(r, 260));
      nextQuestion();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      state.busy = false;
    }
  });

  $('#survey-skip').addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true;
    try {
      await saveAnswer(SURVEY[state.index].id, null);
      nextQuestion();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      state.busy = false;
    }
  });

  $('#survey-back').addEventListener('click', () => {
    if (state.cameFromDone) {
      state.cameFromDone = false;
      renderDone();
      goStep('done');
      return;
    }
    if (state.index === 0) {
      if (editMode === 'survey') location.replace('lobby.html');
      else goStep('name');
      return;
    }
    state.index -= 1;
    renderQuestion();
  });
}

/* ---------- 回答の確認 ---------- */

function renderDone() {
  $('#done-avatar').innerHTML = avatarHtml({ nickname: state.nickname, color: state.color }, 'md');
  $('#done-name').textContent = state.nickname;
  const count = countAnswered(state.survey);
  $('#done-count').textContent = count === SURVEY.length
    ? '5問すべて回答済み'
    : `${count}/5問 回答済み（残りはプリセットのお題で遊べます）`;
  $('#summary-list').innerHTML = SURVEY.map((q, i) => {
    const key = state.survey[q.id];
    const answered = key === 'A' || key === 'B';
    return `
      <li>
        <button type="button" class="summary-item" data-index="${i}">
          <span class="summary-body">
            <span class="summary-q">Q${q.order}. ${escapeHtml(q.text)}</span><br>
            <span class="summary-a${answered ? '' : ' is-empty'}">
              ${answered ? `${key}：${escapeHtml(q.options[key].label)}` : '未回答'}
            </span>
          </span>
          <span class="chev" aria-hidden="true">›</span>
        </button>
      </li>`;
  }).join('');
  $('#done-submit').textContent = editMode ? '保存してホームへ' : 'はじめる';
}

function setupDoneStep() {
  $('#summary-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.summary-item');
    if (!btn) return;
    state.index = Number(btn.dataset.index);
    state.cameFromDone = true;
    renderQuestion();
    goStep('survey');
  });
  $('#done-submit').addEventListener('click', () => {
    location.replace(editMode ? 'lobby.html' : safeNext());
  });
}

/* ---------- 起動 ---------- */

async function main() {
  showLocalBanner();
  state.uid = await signIn();
  const player = await store.getPlayer(state.uid);
  if (player) {
    state.nickname = player.nickname || '';
    state.color = player.color || state.color;
    state.survey = { ...(player.survey || {}) };
  }

  setupNameStep();
  setupSurveyStep();
  setupDoneStep();

  if (editMode === 'survey' && state.nickname) {
    state.index = 0;
    renderQuestion();
    goStep('survey');
  } else {
    goStep('name');
    $('#nickname').focus();
  }
}

main().catch(showFatal);
