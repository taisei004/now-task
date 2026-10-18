import { z } from "zod";
import type { Env } from "./auth";
import type { Focus, FocusState } from "../shared/focus";
export const FocusSchema = z
  .object({
    taskId: z.string().min(1).max(100),
    remaining: z.number().int().min(0).max(600),
    endsAt: z.number().int().nullable(),
  })
  .nullable();
export async function readFocus(env: Env, userId: string): Promise<FocusState> {
  const row = await env.DB.prepare(
    "SELECT data,version FROM focus_sessions WHERE user_id=?",
  )
    .bind(userId)
    .first<{ data: string | null; version: number }>();
  if (!row) return { focus: null, version: 0 };
  const focus = row.data ? (JSON.parse(row.data) as Focus) : null;
  if (focus) {
    const task = await env.DB.prepare(
      "SELECT data FROM tasks WHERE user_id=? AND id=?",
    )
      .bind(userId, focus.taskId)
      .first<{ data: string }>();
    if (!task || JSON.parse(task.data).status !== "todo")
      return { focus: null, version: row.version };
    if (focus.endsAt && focus.endsAt <= Date.now())
      return {
        focus: { ...focus, endsAt: null, remaining: 0 },
        version: row.version,
      };
  }
  return { focus, version: row.version };
}
export async function writeFocus(
  env: Env,
  userId: string,
  focus: Focus | null,
  expected?: number,
): Promise<FocusState | null> {
  const data = focus ? JSON.stringify(focus) : null;
  // Compare-and-swap revisions protect writes from concurrent tabs and Discord.
  const query =
    expected !== undefined && expected > 0
      ? env.DB.prepare(
          "UPDATE focus_sessions SET data=?,version=version+1 WHERE user_id=? AND version=? RETURNING version",
        ).bind(data, userId, expected)
      : env.DB.prepare(
          "INSERT INTO focus_sessions(user_id,data,version) VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,version=focus_sessions.version+1 WHERE ? IS NULL OR focus_sessions.version=? RETURNING version",
        ).bind(userId, data, expected ?? null, expected ?? null);
  const row = await query.first<{ version: number }>();
  return row ? { focus, version: row.version } : null;
}
