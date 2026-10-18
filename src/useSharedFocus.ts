import { useEffect, useRef } from "react";
import { api } from "./storage";
import type { Focus, FocusState } from "../shared/focus";
// Explicit user actions write the timer; rendering and countdown ticks never write it.
export function useSharedFocus(
  scope: string,
  setFocus: (focus: Focus | null) => void,
  sync: () => Promise<void>,
  notice: (message: string) => void,
) {
  const current = useRef({ scope, setFocus, sync, notice });
  current.current = { scope, setFocus, sync, notice };
  const writing = useRef(0),
    generation = useRef(0),
    queue = useRef(Promise.resolve());
  useEffect(() => {
    if (scope === "guest") return;
    let active = true,
      running = false,
      checks = 0;
    const poll = async () => {
      if (running || writing.current || document.visibilityState !== "visible")
        return;
      running = true;
      const version = generation.current;
      try {
        const state = await api<FocusState>("/api/focus");
        if (checks++ % 3 === 0 || state.focus) await current.current.sync();
        if (active && !writing.current && version === generation.current)
          current.current.setFocus(state.focus);
      } catch {
        /* Offline work retains the timer stored on this device. */
      } finally {
        running = false;
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 5000);
    const visible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [scope]);
  return (focus: Focus | null) => {
    current.current.setFocus(focus);
    if (scope === "guest") return;
    generation.current++;
    writing.current++;
    queue.current = queue.current
      .then(async () => {
        if (current.current.scope !== scope) return;
        try {
          await current.current.sync();
          const remote = await api<FocusState>("/api/focus");
          await api<FocusState>("/api/focus", {
            focus,
            version: remote.version,
          });
        } catch (e) {
          if (current.current.scope === scope)
            current.current.notice(
              `タイマーを共有できませんでした。${(e as Error).message}`,
            );
        }
      })
      .finally(() => {
        writing.current--;
      });
  };
}
