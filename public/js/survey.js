// 事前アンケート（全5問）のマスターデータ。
// targetWords はワード・スナイパー用：相手が選んだ選択肢に関連する言葉を「言わせるワード」にします。
// betPrompt はプロファイル・ベット用の出題文で、{name} が主役の名前に置き換わります。
export const SURVEY = [
  {
    id: 'q1',
    order: 1,
    text: '初デートの食事代は？',
    theme: 'デートとお金の話',
    betPrompt: '{name}さんの初デートの食事代はどっち派？',
    options: {
      A: { label: '完全割り勘', emoji: '🤝', targetWords: ['割り勘', 'コスパ', '節約'] },
      B: { label: 'どちらかが多めに払う', emoji: '💝', targetWords: ['ごちそうさま', '記念日', '奢る'] },
    },
  },
  {
    id: 'q2',
    order: 2,
    text: '恋人のスマホ、見る？',
    theme: '恋人との信頼関係',
    betPrompt: '{name}さんは恋人のスマホ、どうする派？',
    options: {
      A: { label: '絶対見ない', emoji: '🙈', targetWords: ['信頼', 'プライバシー', '自由'] },
      B: { label: '隙があれば見たい', emoji: '👀', targetWords: ['嫉妬', '通知', '浮気'] },
    },
  },
  {
    id: 'q3',
    order: 3,
    text: '休日の予定は？',
    theme: '休日の過ごし方',
    betPrompt: '{name}さんの休日はどっち派？',
    options: {
      A: { label: '家から一歩も出ない', emoji: '🛋️', targetWords: ['二度寝', 'ゴロゴロ', '映画'] },
      B: { label: '外出・アクティブ', emoji: '🏕️', targetWords: ['キャンプ', '旅行', '早起き'] },
    },
  },
  {
    id: 'q4',
    order: 4,
    text: '学生時代の立ち位置は？',
    theme: '学生時代の思い出',
    betPrompt: '{name}さんの学生時代の立ち位置はどっち？',
    options: {
      A: { label: '目立つリーダー・部活', emoji: '📣', targetWords: ['キャプテン', '部活', '文化祭'] },
      B: { label: 'マイペース・少人数', emoji: '📚', targetWords: ['図書室', '帰宅部', 'マイペース'] },
    },
  },
  {
    id: 'q5',
    order: 5,
    text: '恋人との連絡頻度は？',
    theme: '連絡のとり方',
    betPrompt: '{name}さんの恋人との連絡はどっち派？',
    options: {
      A: { label: '用件のみ・即レス', emoji: '⚡', targetWords: ['既読', '即レス', '電話'] },
      B: { label: 'たわいもない雑談', emoji: '💬', targetWords: ['寝落ち', 'おやすみ', 'スタンプ'] },
    },
  },
];

export function getQuestion(id) {
  return SURVEY.find((q) => q.id === id) || null;
}
