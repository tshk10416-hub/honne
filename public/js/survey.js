// 事前アンケート（全5問）のマスターデータ。
// targetWords はワード・スナイパー用：相手が選んだ回答そのものの言葉（その話になれば本人が自然に口にする語）を「言わせるワード」にします。
// talkTip はワード・スナイパーの攻略ヒントで、その回答を引き出す話の振り方です。
// betPrompt はプロファイル・ベット用の出題文で、{name} が主役の名前に置き換わります。
export const SURVEY = [
  {
    id: 'q1',
    order: 1,
    text: '初デートの食事代は？',
    theme: 'デートとお金の話',
    betPrompt: '{name}さんの初デートの食事代はどっち派？',
    talkTip: 'ごはんやデートのお会計の話を振ってみよう',
    options: {
      A: { label: '完全割り勘', emoji: '🤝', targetWords: ['割り勘', '半分こ'] },
      B: { label: 'どちらかが多めに払う', emoji: '💝', targetWords: ['おごる', 'ごちそう'] },
    },
  },
  {
    id: 'q2',
    order: 2,
    text: '恋人のスマホ、見る？',
    theme: '恋人との信頼関係',
    betPrompt: '{name}さんは恋人のスマホ、どうする派？',
    talkTip: '恋人とのスマホやSNSの話を振ってみよう',
    options: {
      A: { label: '絶対見ない', emoji: '🙈', targetWords: ['見ない', '信頼'] },
      B: { label: '隙があれば見たい', emoji: '👀', targetWords: ['見たい', '浮気'] },
    },
  },
  {
    id: 'q3',
    order: 3,
    text: '休日の予定は？',
    theme: '休日の過ごし方',
    betPrompt: '{name}さんの休日はどっち派？',
    talkTip: '週末や休みの日の過ごし方を聞いてみよう',
    options: {
      A: { label: '家から一歩も出ない', emoji: '🛋️', targetWords: ['家', 'インドア', 'ゴロゴロ'] },
      B: { label: '外出・アクティブ', emoji: '🏕️', targetWords: ['外出', 'アウトドア', '出かける'] },
    },
  },
  {
    id: 'q4',
    order: 4,
    text: '学生時代の立ち位置は？',
    theme: '学生時代の思い出',
    betPrompt: '{name}さんの学生時代の立ち位置はどっち？',
    talkTip: '学生時代の部活や友達の話を聞いてみよう',
    options: {
      A: { label: '目立つリーダー・部活', emoji: '📣', targetWords: ['部活', 'リーダー', 'キャプテン'] },
      B: { label: 'マイペース・少人数', emoji: '📚', targetWords: ['マイペース', '少人数', '帰宅部'] },
    },
  },
  {
    id: 'q5',
    order: 5,
    text: '恋人との連絡頻度は？',
    theme: '連絡のとり方',
    betPrompt: '{name}さんの恋人との連絡はどっち派？',
    talkTip: 'LINEや電話のやりとりの話を振ってみよう',
    options: {
      A: { label: '用件のみ・即レス', emoji: '⚡', targetWords: ['即レス', '用件'] },
      B: { label: 'たわいもない雑談', emoji: '💬', targetWords: ['雑談', 'LINE', 'おやすみ'] },
    },
  },
];

export function getQuestion(id) {
  return SURVEY.find((q) => q.id === id) || null;
}
