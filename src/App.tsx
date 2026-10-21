import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Cloud,
  CloudOff,
  CornerDownLeft,
  Ellipsis,
  Flag,
  Inbox,
  ListFilter,
  LoaderCircle,
  LogOut,
  Mic,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Timer,
  X,
} from "lucide-react";
import {
  dateKey,
  newTask,
  rankTasks,
  recommend,
  swipeStatus,
  type Task,
  type Recommendation,
} from "../shared/tasks";
import {
  api,
  getDraft,
  readTasks,
  saveDraft,
  getCaptureOptions,
  saveCaptureOptions,
  emptyCapture,
  type CaptureOptions,
} from "./storage";
import TagPicker, { TagPill, defaultTags } from "./TagPicker";
import { useVoiceInput } from "./useVoiceInput";
import DiscordSettings from "./DiscordSettings";
import NotionSettings from "./NotionSettings";
import { useSharedFocus } from "./useSharedFocus";
import { useTasks } from "./useTasks";
type View = "todo" | "held" | "done";
type Focus = { taskId: string; remaining: number; endsAt: number | null };
const dueLabel = (due: string | null) =>
  !due
    ? "期限なし"
    : due === dateKey()
      ? "今日"
      : due < dateKey()
        ? "期限超過"
        : due.replace(/^\d{4}-/, "").replace("-", "/");
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal glass"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-header">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="閉じる">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function TaskRow({
  task,
  onStatus,
  onEdit,
  reduced,
}: {
  task: Task;
  onStatus: (t: Task, s: Task["status"]) => void;
  onEdit: (t: Task) => void;
  reduced: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <motion.div
      layout={!reduced}
      initial={{ opacity: 0, y: reduced ? 0 : 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      className="swipe-wrap"
    >
      <div className="swipe-under">
        <span>
          <Check size={18} />
          完了
        </span>
        <span>
          保留
          <Pause size={16} />
        </span>
      </div>
      <motion.article
        className={`task-row ${task.status === "done" ? "is-done" : ""}`}
        drag={task.status === "todo" ? "x" : false}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.75}
        style={{ touchAction: "pan-y" }}
        onDragStart={() => setDragging(true)}
        onDragEnd={(_, info) => {
          const status = swipeStatus(info.offset.x, info.velocity.x);
          if (status) onStatus(task, status);
          setTimeout(() => setDragging(false), 100);
        }}
      >
        <button
          className={`task-check ${task.status === "done" ? "checked" : ""}`}
          aria-label={
            task.status === "done" ? `${task.text}を戻す` : `${task.text}を完了`
          }
          onClick={() =>
            onStatus(task, task.status === "done" ? "todo" : "done")
          }
        >
          {task.status === "done" && <Check size={14} />}
        </button>
        <button
          className="task-body"
          onClick={() => {
            if (!dragging) onEdit(task);
          }}
        >
          <span className="task-text">{task.text}</span>
          {!!task.tags?.length && (
            <span className="task-tags">
              {task.tags.map((tag) => (
                <TagPill key={tag.name} tag={tag} />
              ))}
            </span>
          )}
          <span className="task-meta">
            {task.project && <span>{task.project}</span>}
            {task.needsReview && <span className="urgent">要確認</span>}
            {task.due && (
              <span className={task.due <= dateKey() ? "urgent" : ""}>
                {dueLabel(task.due)}
              </span>
            )}
            {task.importance === "high" && (
              <span>
                <Flag size={11} />
                重要
              </span>
            )}
            {task.status === "held" && (
              <span>{task.holdReason ?? "保留中"}</span>
            )}
            <span>{task.minutes}分</span>
          </span>
        </button>
        {task.status === "held" ? (
          <button
            className="icon-button"
            onClick={() => onStatus(task, "todo")}
            aria-label={`${task.text}を再開`}
          >
            <RotateCcw size={17} />
          </button>
        ) : (
          <button
            className="icon-button row-more"
            onClick={() => onEdit(task)}
            aria-label={`${task.text}の詳細`}
          >
            <Ellipsis size={20} />
          </button>
        )}
      </motion.article>
    </motion.div>
  );
}
export default function App() {
  const {
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
  } = useTasks();
  const reduced = !!useReducedMotion();
  const [text, setText] = useState(""),
    [view, setView] = useState<View>("todo"),
    [query, setQuery] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [modal, setModal] = useState<"settings" | "hold" | "voice" | null>(null),
    [capture, setCapture] = useState<CaptureOptions>(emptyCapture),
    [captureScope, setCaptureScope] = useState(""),
    [tagFilter, setTagFilter] = useState(""),
    [editing, setEditing] = useState<Task | null>(null),
    [holding, setHolding] = useState<Task | null>(null),
    [sort, setSort] = useState<"priority" | "newest">("priority"),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [undo, setUndo] = useState<Task | null>(null),
    [recommendation, setRecommendation] = useState<Recommendation | null>(null),
    [aiBusy, setAiBusy] = useState(false),
    [focus, setFocus] = useState<Focus | null>(null),
    [tick, setTick] = useState(Date.now()),
    [guestCount, setGuestCount] = useState(0),
    [focusScope, setFocusScope] = useState("");
  const input = useRef<HTMLTextAreaElement>(null),
    noticeTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    ),
    draftVersion = useRef(0),
    saveQueue = useRef(Promise.resolve());
  const flash = (message: string) => {
    setNotice(message);
    clearTimeout(noticeTimeout.current);
    noticeTimeout.current = setTimeout(() => {
      setNotice("");
      setUndo(null);
    }, 6000);
  };
  const shareFocus = useSharedFocus(scope, setFocus, sync, flash);
  useEffect(() => {
    if (new URLSearchParams(location.hash.slice(1)).has("notion"))
      setModal("settings");
  }, []);
  useEffect(() => {
    let active = true;
    const version = ++draftVersion.current;
    void getDraft(scope).then((d) => {
      if (active && version === draftVersion.current) setText(d);
    });
    void getCaptureOptions(scope).then((value) => {
      if (active) {
        setCapture(value);
        setCaptureScope(scope);
      }
    });
    setTagFilter("");
    try {
      const saved = localStorage.getItem(`now-focus:${scope}`);
      setFocus(saved ? JSON.parse(saved) : null);
    } catch {
      setFocus(null);
    }
    setFocusScope(scope);
    return () => {
      active = false;
    };
  }, [scope]);
  useEffect(() => {
    if (captureScope === scope)
      void saveCaptureOptions(scope, capture).catch(() =>
        flash("入力設定を保存できませんでした。"),
      );
  }, [capture, captureScope, scope]);
  useEffect(() => {
    const interval = setInterval(() => setTick(Date.now()), 500);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    if (focusScope !== scope) return;
    if (focus)
      localStorage.setItem(`now-focus:${scope}`, JSON.stringify(focus));
    else localStorage.removeItem(`now-focus:${scope}`);
  }, [focus, scope, focusScope]);
  useEffect(() => {
    if (focus?.endsAt && tick >= focus.endsAt) {
      setFocus({ ...focus, remaining: 0, endsAt: null });
      flash("10分経ちました。続けるか、いったん区切れます。");
    }
  }, [tick, focus]);
  useEffect(() => {
    if (
      focus &&
      !tasks.some(
        (t) => t.id === focus.taskId && t.status === "todo" && !t.needsReview,
      ) &&
      !loading
    )
      setFocus(null);
  }, [tasks, loading, focus]);
  useEffect(() => {
    let active = true;
    if (user)
      void readTasks("guest").then((guest) => {
        if (active)
          setGuestCount(
            guest.filter((t) => !tasks.some((existing) => existing.id === t.id))
              .length,
          );
      });
    return () => {
      active = false;
    };
  }, [user, tasks]);
  useEffect(() => {
    const auth = new URLSearchParams(location.search).get("auth");
    if (auth) {
      flash(
        auth === "unconfigured"
          ? "Googleログインは公開設定後に利用できます。"
          : "ログインを完了できませんでした。もう一度お試しください。",
      );
      history.replaceState(null, "", location.pathname);
    }
  }, []);
  const signature = tasks
    .map((t) => `${t.id}:${t.updatedAt}`)
    .sort()
    .join("|");
  const today = dateKey(new Date(tick));
  useEffect(() => {
    let active = true;
    setRecommendation(recommend(tasks, today));
    if (
      !user ||
      syncState !== "saved" ||
      !tasks.some((t) => t.status === "todo")
    ) {
      setAiBusy(false);
      return;
    }
    setAiBusy(true);
    const timeout = setTimeout(() => {
      void api<{ recommendation: Recommendation | null }>("/api/next", {
        today,
      })
        .then((data) => {
          if (active) setRecommendation(data.recommendation);
        })
        .catch(() => {
          if (active)
            setRecommendation((r) =>
              r
                ? {
                    ...r,
                    warning:
                      "AIに接続できません。期限と重要度から選んでいます。",
                  }
                : null,
            );
        })
        .finally(() => {
          if (active) setAiBusy(false);
        });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [signature, user, syncState, today]);
  const onText = (value: string) => {
    draftVersion.current++;
    setText(value);
    saveQueue.current = saveQueue.current
      .then(() => saveDraft(scope, value))
      .catch(() =>
        flash("下書きを保存できません。端末の空き容量をご確認ください。"),
      );
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    const value = text.trim();
    try {
      const task = newTask(value);
      if (capture.due) task.due = capture.due;
      if (capture.importance !== "auto") task.importance = capture.importance;
      task.tags = capture.tags;
      task.source = capture.source ?? "now";
      await mutate(task);
      onText("");
      setCapture(emptyCapture());
      input.current?.focus();
      flash("追加しました");
    } catch {
      flash("保存できませんでした。入力は残っています。");
    } finally {
      setBusy(false);
    }
  };
  const voice = useVoiceInput(
    (value) => {
      setCapture((previous) => ({ ...previous, source: "voice" }));
      onText(
        (text + (text && !text.endsWith("\n") ? "\n" : "") + value).slice(
          0,
          2000,
        ),
      );
    },
    flash,
    scope,
  );
  const allTags = [
    ...new Map(
      [...defaultTags, ...tasks.flatMap((t) => t.tags ?? [])].map((tag) => [
        tag.name,
        tag,
      ]),
    ).values(),
  ];
  const toggleVoice = () => {
    if (localStorage.getItem("now-voice-consent") === "yes" || !voice.supported)
      voice.toggle();
    else setModal("voice");
  };
  const changeStatus = async (
    task: Task,
    status: Task["status"],
    reason: string | null = null,
  ) => {
    if (status === "held" && !reason) {
      setHolding(task);
      setModal("hold");
      return;
    }
    try {
      await mutate({
        ...task,
        status,
        holdReason: reason,
        updatedAt: Date.now(),
      });
      setUndo(task);
      flash(
        status === "done"
          ? "完了しました"
          : status === "held"
            ? "保留にしました"
            : "未完了に戻しました",
      );
      if (focus?.taskId === task.id) setFocus(null);
    } catch {
      flash("保存できませんでした。もう一度お試しください。");
    }
  };
  const chosen =
    tasks.find(
      (t) => t.id === focus?.taskId && t.status === "todo" && !t.needsReview,
    ) ??
    tasks.find(
      (t) =>
        t.id === recommendation?.taskId &&
        t.status === "todo" &&
        !t.needsReview,
    ) ??
    rankTasks(tasks, today)[0];
  const chosenRecommendation =
    chosen && recommendation?.taskId === chosen.id
      ? recommendation
      : chosen
        ? recommend([chosen], today)
        : null;
  const remaining = focus
    ? focus.endsAt
      ? Math.min(600, Math.max(0, Math.ceil((focus.endsAt - tick) / 1000)))
      : focus.remaining
    : 600;
  const timerText = `${Math.floor(remaining / 60)
    .toString()
    .padStart(2, "0")}:${(remaining % 60).toString().padStart(2, "0")}`;
  const startFocus = () => {
    if (chosen)
      shareFocus({
        taskId: chosen.id,
        remaining: 600,
        endsAt: Date.now() + 600000,
      });
  };
  const pauseFocus = () => {
    if (focus)
      shareFocus({
        ...focus,
        remaining,
        endsAt: focus.endsAt
          ? null
          : Date.now() + (remaining > 0 ? remaining : 600) * 1000,
      });
  };
  const counts = {
    todo: tasks.filter((t) => t.status === "todo").length,
    held: tasks.filter((t) => t.status === "held").length,
    done: tasks.filter((t) => t.status === "done").length,
  };
  const displayed = (
    sort === "priority" && view === "todo"
      ? rankTasks(tasks, today)
      : tasks
          .filter((t) => t.status === view)
          .sort((a, b) => b.updatedAt - a.updatedAt)
  ).filter(
    (t) =>
      t.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
      (!tagFilter || t.tags?.some((tag) => tag.name === tagFilter)),
  );
  const completedToday = tasks.filter(
    (t) => t.status === "done" && dateKey(new Date(t.updatedAt)) === today,
  ).length;
  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <a href="/" className="brand" aria-label="Now ホーム">
          <span className="brand-icon">n</span>
          <span>
            now<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="header-actions">
          <span className="sync-label">
            {syncState === "syncing" ? (
              <LoaderCircle size={13} className="spin" />
            ) : syncState === "offline" ? (
              <CloudOff size={14} />
            ) : user ? (
              <Cloud size={14} />
            ) : (
              <span className="local-dot" />
            )}
            {user
              ? syncState === "syncing"
                ? "同期中"
                : syncState === "offline"
                  ? "未同期"
                  : "同期済み"
              : "この端末に保存"}
          </span>
          <button
            className="avatar glass"
            onClick={() => setModal("settings")}
            aria-label="設定を開く"
          >
            {user ? user.name.slice(0, 1) : <Settings2 size={18} />}
          </button>
        </div>
      </header>
      <main>
        <div className="date-row">
          <span>
            {new Intl.DateTimeFormat("ja-JP", {
              month: "long",
              day: "numeric",
              weekday: "long",
            }).format(new Date(tick))}
          </span>
          <span className="today-done">
            <Check size={13} />
            {completedToday} 件完了
          </span>
        </div>
        <section className="capture glass" aria-label="タスクを追加">
          <form onSubmit={submit}>
            <div className="capture-top">
              <span className="section-kicker">
                <span className="capture-dot" />
                クイックメモ
              </span>
              <span className="key-hint">⌘ / Ctrl ＋ Enter</span>
            </div>
            <textarea
              ref={input}
              autoFocus
              aria-label="タスクを入力"
              placeholder="やることを、そのまま。"
              maxLength={2000}
              rows={2}
              value={text}
              onChange={(e) => onText(e.target.value)}
              onKeyDown={(e) => {
                if (
                  (e.metaKey || e.ctrlKey) &&
                  e.key === "Enter" &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void submit(e);
                }
              }}
            />
            <div className="capture-options">
              <label>
                期日
                <input
                  aria-label="メモの期日"
                  type="date"
                  value={capture.due}
                  onChange={(e) =>
                    setCapture({ ...capture, due: e.target.value })
                  }
                />
              </label>
              <label>
                重要度
                <select
                  aria-label="メモの重要度"
                  value={capture.importance}
                  onChange={(e) =>
                    setCapture({
                      ...capture,
                      importance: e.target
                        .value as CaptureOptions["importance"],
                    })
                  }
                >
                  <option value="auto">自動</option>
                  <option value="normal">通常</option>
                  <option value="high">重要</option>
                </select>
              </label>
              <TagPicker
                value={capture.tags}
                options={allTags}
                onChange={(tags) => setCapture({ ...capture, tags })}
              />
            </div>
            {!!capture.tags.length && (
              <div className="selected-tags">
                {capture.tags.map((tag) => (
                  <button
                    type="button"
                    key={tag.name}
                    aria-label={`${tag.name}タグを外す`}
                    onClick={() =>
                      setCapture({
                        ...capture,
                        tags: capture.tags.filter((t) => t.name !== tag.name),
                      })
                    }
                  >
                    <TagPill tag={tag} />
                    <X size={12} />
                  </button>
                ))}
              </div>
            )}
            {(voice.listening || voice.interim) && (
              <p className="voice-status" role="status">
                {voice.interim || "聞き取り中…"}
              </p>
            )}
            <div className="capture-bottom">
              <span>
                {text.length
                  ? `${text.length} / 2000`
                  : "「明日」「重要」もそのまま入力"}
              </span>
              <div className="capture-actions">
                <button
                  className={`icon-button mic-button ${voice.listening ? "listening" : ""}`}
                  type="button"
                  aria-label={voice.listening ? "音声入力を停止" : "音声入力"}
                  aria-pressed={voice.listening}
                  onClick={toggleVoice}
                >
                  <Mic size={19} />
                </button>
                <button
                  className="add-button"
                  type="submit"
                  disabled={!text.trim() || busy}
                  aria-label="タスクを追加"
                >
                  {busy ? (
                    <LoaderCircle size={18} className="spin" />
                  ) : (
                    <ArrowUp size={19} />
                  )}
                </button>
              </div>
            </div>
          </form>
        </section>
        {error && (
          <div className="inline-error" role="status">
            <CloudOff size={14} />
            <span>{error}</span>
            {user && <button onClick={() => void sync()}>再試行</button>}
          </div>
        )}
        <div className="workspace">
          <section className="next-section" aria-label="次のタスク">
            <div className="section-heading">
              <h1>
                <span className="blue-dot" />
                今やること
              </h1>
              <span className="small-label">
                {focus
                  ? remaining === 0
                    ? "10分経過"
                    : focus.endsAt
                      ? "集中中"
                      : "一時停止"
                  : aiBusy
                    ? "優先順位を確認中"
                    : recommendation?.source === "ai"
                      ? "Workers AI"
                      : "期限・重要度順"}
              </span>
            </div>
            {loading ? (
              <div
                className="focus-skeleton skeleton"
                aria-label="タスクを読み込み中"
              />
            ) : (
              <AnimatePresence mode="wait">
                <motion.div
                  key={chosen?.id ?? "empty"}
                  initial={{
                    opacity: 0,
                    y: reduced ? 0 : 12,
                    filter: reduced ? "none" : "blur(5px)",
                  }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: reduced ? 0 : -8 }}
                  transition={{ duration: reduced ? 0 : 0.25 }}
                  className={`focus-card glass ${focus ? "is-focusing" : ""}`}
                >
                  {chosen ? (
                    <>
                      <div className="focus-card-top">
                        <span className="focus-label">
                          <Sparkles size={14} />
                          NEXT UP
                        </span>
                        <span
                          className={`due-pill ${chosen.due && chosen.due <= today ? "due-today" : ""}`}
                        >
                          {dueLabel(chosen.due)}
                        </span>
                      </div>
                      <h2>{chosen.text}</h2>
                      <div className="reason">
                        <span className="reason-line" />
                        <p>{chosenRecommendation?.reason}</p>
                      </div>
                      {chosenRecommendation?.warning && (
                        <p className="ai-warning">
                          {chosenRecommendation.warning}
                        </p>
                      )}
                      <div className="ten-min">
                        <Timer size={16} />
                        <span>
                          {chosenRecommendation?.firstStep ??
                            "このタスクに10分取り組む"}
                        </span>
                      </div>
                      {focus ? (
                        <div className="timer-panel">
                          <div
                            className="timer-ring"
                            style={
                              {
                                "--progress": `${(remaining / 600) * 100}%`,
                              } as React.CSSProperties
                            }
                          >
                            <div>
                              <span
                                className="timer-digits"
                                role="timer"
                                aria-label={`残り${timerText}`}
                              >
                                {timerText}
                              </span>
                              <span>
                                {remaining === 0
                                  ? "10分経過"
                                  : focus.endsAt
                                    ? "集中中"
                                    : "一時停止"}
                              </span>
                            </div>
                          </div>
                          <div className="timer-actions">
                            <button
                              className="secondary-button"
                              onClick={pauseFocus}
                            >
                              {focus.endsAt ? (
                                <Pause size={15} />
                              ) : (
                                <Play size={15} />
                              )}
                              {focus.endsAt
                                ? "一時停止"
                                : remaining === 0
                                  ? "もう10分"
                                  : "再開"}
                            </button>
                            <button
                              className="text-button"
                              onClick={() => shareFocus(null)}
                            >
                              区切る
                            </button>
                          </div>
                        </div>
                      ) : null}
                      <div className="focus-actions">
                        {!focus && (
                          <button
                            className="primary-button"
                            onClick={startFocus}
                          >
                            <Play size={16} fill="currentColor" />
                            10分だけ始める
                            <ArrowRight size={16} />
                          </button>
                        )}
                        <button
                          className={
                            focus ? "primary-button" : "complete-button"
                          }
                          onClick={() => void changeStatus(chosen, "done")}
                        >
                          <Check size={18} />
                          完了{focus && <ArrowRight size={16} />}
                        </button>
                        <button
                          className="hold-button"
                          onClick={() => void changeStatus(chosen, "held")}
                          aria-label="今は難しい"
                        >
                          <Pause size={16} />
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="empty-focus">
                      <div className="empty-orbit">
                        <Check size={26} />
                      </div>
                      <h2>
                        {counts.held
                          ? "未完了のタスクはありません"
                          : "次のタスクを追加"}
                      </h2>
                      <p>
                        {counts.held
                          ? "保留中のタスクは、一覧から再開できます。"
                          : "上のメモから追加できます。"}
                      </p>
                      <button
                        className="text-button"
                        onClick={() => {
                          if (counts.held) setView("held");
                          else input.current?.focus();
                        }}
                      >
                        {counts.held ? "保留を確認" : "メモを書く"}
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            )}
            <div className="swipe-guide">
              <span>
                <ArrowLeft size={12} />
                左にフリックで保留
              </span>
              <span>
                右にフリックで完了
                <ArrowRight size={12} />
              </span>
            </div>
          </section>
          <section className="task-section" aria-label="タスク一覧">
            <div className="section-heading">
              <h2>
                タスク<span className="total-count">{tasks.length}</span>
              </h2>
              <div className="list-tools">
                <button
                  className={`icon-button ${searchOpen ? "active" : ""}`}
                  onClick={() => {
                    setSearchOpen(!searchOpen);
                    setQuery("");
                  }}
                  aria-label="タスクを検索"
                  aria-expanded={searchOpen}
                >
                  <Search size={17} />
                </button>
                <button
                  className="icon-button"
                  aria-label={
                    sort === "priority"
                      ? "登録順に切り替え"
                      : "優先順に切り替え"
                  }
                  onClick={() =>
                    setSort(sort === "priority" ? "newest" : "priority")
                  }
                  title={sort === "priority" ? "優先順" : "登録順"}
                >
                  <ListFilter size={18} />
                </button>
              </div>
            </div>
            <div className="tag-filters" aria-label="タグで絞り込み">
              <button
                aria-pressed={!tagFilter}
                onClick={() => setTagFilter("")}
              >
                すべて
              </button>
              {allTags
                .filter((tag) =>
                  tasks.some((task) =>
                    task.tags?.some((t) => t.name === tag.name),
                  ),
                )
                .map((tag) => (
                  <button
                    key={tag.name}
                    aria-pressed={tagFilter === tag.name}
                    onClick={() =>
                      setTagFilter(tagFilter === tag.name ? "" : tag.name)
                    }
                  >
                    <TagPill tag={tag} />
                  </button>
                ))}
            </div>
            <div className="tabs glass" role="tablist" aria-label="ステータス">
              {(["todo", "held", "done"] as View[]).map((v) => (
                <button
                  key={v}
                  role="tab"
                  id={`tab-${v}`}
                  aria-selected={view === v}
                  aria-controls="task-panel"
                  className={view === v ? "selected" : ""}
                  onClick={() => setView(v)}
                >
                  {view === v && (
                    <motion.span
                      layoutId="active-tab"
                      transition={{
                        type: "spring",
                        bounce: 0.15,
                        duration: reduced ? 0 : 0.35,
                      }}
                      className="tab-background"
                    />
                  )}
                  <span>
                    {v === "todo" ? "未完了" : v === "held" ? "保留" : "完了"}
                    <span className="tab-count">{counts[v]}</span>
                  </span>
                </button>
              ))}
            </div>
            <AnimatePresence>
              {searchOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="search-box"
                >
                  <Search size={16} />
                  <input
                    autoFocus
                    aria-label="タスクの検索語"
                    placeholder="タスクを検索"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </motion.div>
              )}
            </AnimatePresence>
            <div
              className="task-list"
              id="task-panel"
              role="tabpanel"
              aria-labelledby={`tab-${view}`}
            >
              {loading ? (
                <>
                  <div className="row-skeleton skeleton" />
                  <div className="row-skeleton skeleton" />
                  <div className="row-skeleton skeleton" />
                </>
              ) : (
                <AnimatePresence initial={false} mode="popLayout">
                  {displayed.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      onStatus={(task, status) =>
                        void changeStatus(task, status)
                      }
                      onEdit={setEditing}
                      reduced={reduced}
                    />
                  ))}
                </AnimatePresence>
              )}
              {!loading && !displayed.length && (
                <div className="empty-list">
                  <Inbox size={23} />
                  <p>
                    {query
                      ? "一致するタスクはありません"
                      : view === "held"
                        ? "保留中のタスクはありません"
                        : view === "done"
                          ? "完了したタスクはありません"
                          : "タスクはありません"}
                  </p>
                </div>
              )}
            </div>
            <div className="list-footer">
              <span>{sort === "priority" ? "優先順" : "登録が新しい順"}</span>
              <span>{displayed.length} 件</span>
            </div>
          </section>
        </div>
        <footer className="app-footer">
          <span className="footer-mark">n</span>
          <span>{user ? "Cloudflare に同期" : "端末内に保存中"}</span>
          <button onClick={() => setModal("settings")}>
            {user ? "アカウント" : "Googleで同期"}
            <ArrowRight size={12} />
          </button>
        </footer>
      </main>
      <AnimatePresence>
        {notice && (
          <motion.div
            role="status"
            className="toast glass"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
          >
            <Check size={16} />
            <span>{notice}</span>
            {undo && (
              <button
                onClick={() => {
                  void mutate({ ...undo, updatedAt: Date.now() })
                    .then(() => {
                      setUndo(null);
                      flash("取り消しました");
                    })
                    .catch(() => flash("取り消せませんでした。"));
                }}
              >
                取り消す
              </button>
            )}
            <button
              className="icon-button"
              aria-label="通知を閉じる"
              onClick={() => setNotice("")}
            >
              <X size={15} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      {modal === "voice" && (
        <Modal title="音声入力" onClose={() => setModal(null)}>
          <p className="settings-note">
            マイクで話した内容をメモ欄に入力します。音声はブラウザの音声認識サービスに送信される場合があります。内容を確認してから追加できます。
          </p>
          <button
            className="primary-button"
            onClick={() => {
              localStorage.setItem("now-voice-consent", "yes");
              setModal(null);
              voice.toggle();
            }}
          >
            音声入力を始める
            <Mic size={17} />
          </button>
        </Modal>
      )}
      {modal === "settings" && (
        <Modal title="設定" onClose={() => setModal(null)}>
          <div className="account-card">
            <div className="account-icon">
              <Cloud size={23} />
            </div>
            <div>
              <strong>{user ? user.name : "Googleで同期"}</strong>
              <p>{user ? user.email : "タスクをほかの端末でも使う"}</p>
            </div>
          </div>
          {user ? (
            <>
              <div className="settings-info">
                <span>保存先</span>
                <strong>Cloudflare D1</strong>
              </div>
              <div className="settings-info">
                <span>優先順位の提案</span>
                <strong>Workers AI</strong>
              </div>
              <DiscordSettings />
              <NotionSettings syncTasks={sync} />
              {guestCount > 0 && (
                <button
                  className="wide-secondary"
                  onClick={() => {
                    void importGuest()
                      .then((n) => {
                        setGuestCount(0);
                        flash(`${n}件をアカウントに追加しました`);
                        setModal(null);
                      })
                      .catch(() => flash("追加できませんでした。"));
                  }}
                >
                  この端末のメモ {guestCount} 件を取り込む
                </button>
              )}
              <button className="wide-secondary" onClick={() => void sync()}>
                今すぐ同期
              </button>
              {syncState === "offline" && (
                <a className="google-button" href="/auth/google">
                  Googleで再ログイン
                </a>
              )}
              <button
                className="logout-button"
                onClick={() => void logout().catch((e) => flash(e.message))}
              >
                <LogOut size={16} />
                ログアウト
              </button>
            </>
          ) : (
            <>
              <p className="settings-note">
                ログイン前のメモは、このブラウザに保存されます。ログイン後に取り込めます。
              </p>
              <a className="google-button" href="/auth/google">
                <span className="google-g">G</span>Googleでログイン
              </a>
              {!configured && (
                <p className="config-note">Google認証の接続設定が必要です。</p>
              )}
            </>
          )}
          <div className="settings-info">
            <span>操作</span>
            <span>右：完了 / 左：保留</span>
          </div>
          <div className="settings-info">
            <span>着手時間</span>
            <span>10分</span>
          </div>
        </Modal>
      )}
      {modal === "hold" && holding && (
        <Modal
          title="今は難しい"
          onClose={() => {
            setModal(null);
            setHolding(null);
          }}
        >
          <p className="hold-task">{holding.text}</p>
          <div className="hold-options">
            {[
              "時間が足りない",
              "気が重い",
              "誰かの返事待ち",
              "あとで考える",
            ].map((reason) => (
              <button
                key={reason}
                onClick={() => {
                  void changeStatus(holding, "held", reason);
                  setModal(null);
                  setHolding(null);
                }}
              >
                {reason}
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
          <p className="settings-note">
            保留中のタスクは推薦から外れます。一覧から再開できます。
          </p>
        </Modal>
      )}
      {editing && (
        <Modal title="タスクの詳細" onClose={() => setEditing(null)}>
          <form
            className="edit-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!editing.text.trim()) return;
              void mutate({
                ...editing,
                text: editing.text.trim(),
                updatedAt: Date.now(),
              })
                .then(() => {
                  setEditing(null);
                  flash("更新しました");
                })
                .catch(() => flash("更新できませんでした。"));
            }}
          >
            <label>
              タスク
              <textarea
                autoFocus
                required
                maxLength={2000}
                value={editing.text}
                onChange={(e) =>
                  setEditing({ ...editing, text: e.target.value })
                }
              />
            </label>
            <div className="edit-grid">
              <label>
                期限
                <input
                  type="date"
                  value={editing.due ?? ""}
                  onChange={(e) =>
                    setEditing({ ...editing, due: e.target.value || null })
                  }
                />
              </label>
              <label>
                重要度
                <select
                  value={editing.importance}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      importance: e.target.value as Task["importance"],
                    })
                  }
                >
                  <option value="normal">通常</option>
                  <option value="high">重要</option>
                </select>
              </label>
            </div>
            <div className="edit-tags">
              <span>タグ</span>
              <TagPicker
                value={editing.tags ?? []}
                options={allTags}
                onChange={(tags) => setEditing({ ...editing, tags })}
              />
              <div className="selected-tags">
                {editing.tags?.map((tag) => (
                  <TagPill key={tag.name} tag={tag} />
                ))}
              </div>
            </div>
            {editing.project && (
              <p className="settings-note">案件：{editing.project}</p>
            )}
            {editing.notionUrl && (
              <a href={editing.notionUrl} target="_blank" rel="noreferrer">
                Notionで詳細を開く
              </a>
            )}
            <label className="review-checkbox">
              <input
                type="checkbox"
                checked={!editing.needsReview}
                onChange={(e) =>
                  setEditing({ ...editing, needsReview: !e.target.checked })
                }
              />
              内容を確認済み
            </label>
            <label>
              ステータス
              <select
                value={editing.status}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    status: e.target.value as Task["status"],
                    holdReason:
                      e.target.value === "held" ? "あとで考える" : null,
                  })
                }
              >
                <option value="todo">未完了</option>
                <option value="held">保留</option>
                <option value="done">完了</option>
              </select>
            </label>
            <button className="primary-button" type="submit">
              保存
              <Check size={16} />
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
