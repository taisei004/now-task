import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "../shared/tasks";
import {
  api,
  dirtyTasks,
  markClean,
  mergeRemote,
  readTasks,
  writeTask,
} from "./storage";
export type User = { id: string; name: string; email: string };
export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]),
    [user, setUser] = useState<User | null>(null),
    [scope, setScope] = useState("guest"),
    [loading, setLoading] = useState(true),
    [syncState, setSyncState] = useState<
      "local" | "syncing" | "saved" | "offline"
    >("local"),
    [error, setError] = useState(""),
    [configured, setConfigured] = useState(false);
  const scopeRef = useRef("guest"),
    syncing = useRef(false),
    needsSync = useRef(false),
    alive = useRef(true);
  const sync = useCallback(async () => {
    if (scopeRef.current === "guest") return;
    if (syncing.current) {
      needsSync.current = true;
      return;
    }
    syncing.current = true;
    setSyncState("syncing");
    const current = scopeRef.current;
    try {
      do {
        needsSync.current = false;
        let dirty = await dirtyTasks(current);
        while (dirty.length) {
          const batch = dirty.slice(0, 50);
          await api("/api/sync", { tasks: batch });
          await markClean(current, batch);
          dirty = await dirtyTasks(current);
        }
      } while (needsSync.current);
      const data = await api<{ tasks: Task[] }>("/api/tasks");
      await mergeRemote(current, data.tasks);
      if (alive.current && scopeRef.current === current) {
        setTasks(await readTasks(current));
        setSyncState("saved");
        setError("");
      }
    } catch (e) {
      if (alive.current) {
        setSyncState("offline");
        setError(e instanceof Error ? e.message : "同期できませんでした。");
      }
    } finally {
      syncing.current = false;
      if (needsSync.current) void sync();
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const local = await readTasks("guest");
        if (cancelled) return;
        if (alive.current) {
          setTasks(local);
          setLoading(false);
        }
        const session = await api<{
          user: User | null;
          googleConfigured: boolean;
        }>("/api/session");
        if (cancelled || !alive.current) return;
        setConfigured(session.googleConfigured);
        if (session.user) {
          const next = `user:${session.user.id}`;
          scopeRef.current = next;
          setScope(next);
          setUser(session.user);
          setLoading(true);
          setTasks(await readTasks(next));
          setLoading(false);
          void sync();
        }
      } catch {
        if (!cancelled && alive.current) {
          setLoading(false);
          setError("接続を確認できません。メモはこの端末に保存されます。");
        }
      }
    })();
    const online = () => void sync();
    const visible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      cancelled = true;
      alive.current = false;
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [sync]);
  const mutate = useCallback(
    async (task: Task) => {
      const current = scopeRef.current;
      await writeTask(current, task);
      if (current === scopeRef.current)
        setTasks((ts) => [...ts.filter((t) => t.id !== task.id), task]);
      void sync();
    },
    [sync],
  );
  const importGuest = async () => {
    const guest = await readTasks("guest");
    const existing = new Set(
      (await readTasks(scopeRef.current)).map((t) => t.id),
    );
    const incoming = guest.filter((t) => !existing.has(t.id));
    for (const t of incoming)
      await writeTask(scopeRef.current, { ...t, updatedAt: Date.now() });
    setTasks(await readTasks(scopeRef.current));
    void sync();
    return incoming.length;
  };
  const logout = async () => {
    await sync();
    if ((await dirtyTasks(scopeRef.current)).length)
      throw Error("未同期のタスクがあります。同期後にログアウトしてください。");
    await api("/api/logout", {});
    window.location.reload();
  };
  return {
    tasks,
    user,
    scope,
    loading,
    syncState,
    error,
    configured,
    mutate,
    sync,
    importGuest,
    logout,
  };
}
