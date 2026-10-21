export const TAG_COLORS = [
  "blue",
  "green",
  "purple",
  "amber",
  "rose",
  "slate",
] as const;
export type Tag = { name: string; color: (typeof TAG_COLORS)[number] };
export type Task = {
  id: string;
  text: string;
  status: "todo" | "done" | "held";
  createdAt: number;
  updatedAt: number;
  due: string | null;
  importance: "normal" | "high";
  minutes: number;
  holdReason: string | null;
  tags?: Tag[];
  source?: "now" | "voice" | "chat" | "discord" | "notion";
  needsReview?: boolean;
  notionUrl?: string;
  project?: string;
};
export type Recommendation = {
  taskId: string;
  reason: string;
  firstStep: string;
  source: "ai" | "rules";
  warning?: string;
};
export function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function newTask(
  text: string,
  now = Date.now(),
  today = dateKey(new Date(now)),
): Task {
  let due: string | null = null;
  const d = new Date(`${today}T12:00:00`);
  if (/明後日/.test(text)) d.setDate(d.getDate() + 2);
  else if (/明日/.test(text)) d.setDate(d.getDate() + 1);
  if (/今日|明日|明後日/.test(text)) due = dateKey(d);
  const explicit = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (explicit) {
    const candidate = `${explicit[1]}-${explicit[2].padStart(2, "0")}-${explicit[3].padStart(2, "0")}`;
    const parsed = new Date(`${candidate}T12:00:00`);
    if (!Number.isNaN(+parsed) && dateKey(parsed) === candidate)
      due = candidate;
  }
  return {
    id: crypto.randomUUID(),
    text: text.trim(),
    status: "todo",
    createdAt: now,
    updatedAt: now,
    due,
    importance: /重要|至急|急ぎ/.test(text) ? "high" : "normal",
    minutes: 10,
    holdReason: null,
  };
}
export function rankTasks(tasks: Task[], today = dateKey()): Task[] {
  const score = (t: Task) =>
    (t.due
      ? t.due < today
        ? 10000
        : t.due === today
          ? 8000
          : Math.max(
              0,
              4000 -
                Math.round((Date.parse(t.due) - Date.parse(today)) / 86400000) *
                  100,
            )
      : 0) + (t.importance === "high" ? 1500 : 0);
  return tasks
    .filter((t) => t.status === "todo" && !t.needsReview)
    .sort(
      (a, b) =>
        score(b) - score(a) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    );
}
export function recommend(
  tasks: Task[],
  today = dateKey(),
): Recommendation | null {
  const t = rankTasks(tasks, today)[0];
  if (!t) return null;
  let reason = "登録が早いタスクから、まず10分だけ進めます。";
  if (t.due && t.due < today)
    reason = "期限を過ぎているため、先に進める候補です。";
  else if (t.due === today)
    reason = "今日が期限です。まず10分、進める時間を確保します。";
  else if (t.due)
    reason = `期限（${t.due.replaceAll("-", "/")}）が近いタスクです。余裕を残して進めます。`;
  else if (t.importance === "high")
    reason = "重要に設定されたタスクです。先に10分、時間を確保します。";
  return {
    taskId: t.id,
    reason,
    firstStep: "このタスクに10分取り組む",
    source: "rules",
  };
}
export function swipeStatus(
  offset: number,
  velocity = 0,
): Task["status"] | null {
  if (offset >= 90 || (offset >= 30 && velocity > 500)) return "done";
  if (offset <= -90 || (offset <= -30 && velocity < -500)) return "held";
  return null;
}
