export const discordCommand = {
  name: "now",
  description: "Nowのタスクと10分タイマー",
  type: 1,
  options: [
    {
      type: 1,
      name: "link",
      description: "WebアプリのGoogleアカウントと連携",
      options: [
        {
          type: 3,
          name: "code",
          description: "Webアプリの設定で発行した連携コード",
          required: true,
          min_length: 16,
          max_length: 16,
        },
      ],
    },
    { type: 1, name: "memo", description: "クイックメモを追加" },
    { type: 1, name: "start", description: "次のタスクを10分だけ始める" },
    {
      type: 1,
      name: "panel",
      description: "チャンネルに共通ボタンを設置（管理者用）",
    },
  ],
};
