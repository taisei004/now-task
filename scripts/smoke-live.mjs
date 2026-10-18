// Exercises the actual Worker, D1 and Workers AI using short-lived test fixtures.
// This does not replace a real Google OAuth browser test.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const run = promisify(execFile);
const origin = process.argv[2];
const local = process.argv.includes("--local");
if (
  !origin ||
  !(local ? /^http:\/\/127\.0\.0\.1:\d+$/ : /^https:\/\/[\w.-]+$/).test(origin)
)
  throw Error(
    "Pass the deployed HTTPS origin, or a loopback origin with --local.",
  );
const alice = `test:${randomUUID()}`,
  bob = `test:${randomUUID()}`,
  token = randomBytes(32).toString("hex"),
  bobToken = randomBytes(32).toString("hex");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const sql = async (command) => {
  await run(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "d1",
      "execute",
      "now-task",
      local ? "--local" : "--remote",
      "--command",
      command,
    ],
    { timeout: 60000, maxBuffer: 1024 * 1024 },
  );
};
let passed = 0,
  seeded = false;
const check = (name) => {
  passed++;
  console.log(`PASS ${name}`);
};
const call = (path, { body, userToken = token, requestOrigin = origin } = {}) =>
  fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(userToken ? { Cookie: `now_session=${userToken}` } : {}),
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json", Origin: requestOrigin }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
try {
  const health = await fetch(`${origin}/api/health`, {
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(health.status, 200);
  check(local ? "local endpoint reachable" : "public HTTPS endpoint reachable");
  const now = Date.now();
  seeded = true;
  await sql(
    `INSERT INTO users VALUES('${alice}','alice@example.test','Integration Alice',${now});INSERT INTO users VALUES('${bob}','bob@example.test','Integration Bob',${now});INSERT INTO sessions VALUES('${sha(token)}','${alice}',${now + 900000});INSERT INTO sessions VALUES('${sha(bobToken)}','${bob}',${now + 900000});`,
  );
  assert.equal((await call("/api/tasks", { userToken: null })).status, 401);
  check("unauthenticated requests rejected");
  const session = await (await call("/api/session")).json();
  assert.equal(session.user.id, alice);
  check("real D1 session resolved");
  const today = new Date().toISOString().slice(0, 10),
    urgentId = randomUUID(),
    laterId = randomUUID();
  const make = (id, text, due) => ({
    id,
    text,
    due,
    status: "todo",
    createdAt: now,
    updatedAt: now,
    importance: "normal",
    minutes: 10,
    holdReason: null,
  });
  const urgent = make(urgentId, "今日が期限の見積書を送る", today),
    later = make(laterId, "書類を整理する", null);
  urgent.importance = "high";
  urgent.tags = [{ name: "確認用", color: "rose" }];
  assert.equal(
    (await call("/api/sync", { body: { tasks: [urgent, later] } })).status,
    200,
  );
  check("task writes persisted to D1");
  const stored = await (await call("/api/tasks")).json();
  assert.equal(stored.tasks.length, 2);
  assert.deepEqual(
    stored.tasks.find((t) => t.id === urgentId).tags,
    urgent.tags,
  );
  assert.equal(stored.tasks.find((t) => t.id === urgentId).importance, "high");
  check("tasks read back from D1");
  const focus = {
    taskId: urgentId,
    remaining: 600,
    endsAt: Date.now() + 600000,
  };
  assert.equal(
    (await call("/api/focus", { body: { focus, version: 0 } })).status,
    200,
  );
  assert.equal(
    (await (await call("/api/focus")).json()).focus.taskId,
    urgentId,
  );
  assert.equal(
    (await (await call("/api/focus", { userToken: bobToken })).json()).focus,
    null,
  );
  check("shared timer persisted and isolated");
  assert.equal(
    (await call("/api/focus", { body: { focus: null, version: 0 } })).status,
    409,
  );
  assert.equal(
    (
      await call("/api/focus", {
        body: { focus: { ...focus, remaining: 510, endsAt: null }, version: 1 },
      })
    ).status,
    200,
  );
  assert.equal((await (await call("/api/focus")).json()).focus.remaining, 510);
  check("timer pause and revision conflict enforced");
  assert.equal((await (await call("/api/discord")).json()).configured, true);
  const link = await (await call("/api/discord/link", { body: {} })).json();
  assert.match(link.code, /^[a-f0-9]{16}$/);
  assert.ok(link.expiresAt > Date.now());
  assert.equal((await call("/api/discord/unlink", { body: {} })).status, 200);
  check("Discord setup and one-time link code available");
  assert.equal(
    (
      await fetch(`${origin}/discord/interactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"type":1}',
      })
    ).status,
    401,
  );
  check("unsigned Discord interactions rejected");
  const other = await (
    await call("/api/tasks", { userToken: bobToken })
  ).json();
  assert.equal(other.tasks.length, 0);
  check("cross-user records isolated");
  assert.equal(
    (
      await call("/api/sync", {
        body: { tasks: [] },
        requestOrigin: "https://evil.example",
      })
    ).status,
    403,
  );
  check("cross-origin mutation rejected");
  const first = await (await call("/api/next", { body: { today } })).json();
  if (first.diagnostic)
    console.log("AI diagnostic:", JSON.stringify(first.diagnostic));
  assert.equal(first.recommendation.source, "ai", first.recommendation.warning);
  assert.equal(first.recommendation.taskId, urgentId);
  assert.ok(first.recommendation.reason.length);
  check("real Workers AI returns validated reason and urgent task");
  assert.equal(
    (
      await call("/api/sync", {
        body: { tasks: [{ ...urgent, status: "done", updatedAt: Date.now() }] },
      })
    ).status,
    200,
  );
  const next = await (await call("/api/next", { body: { today } })).json();
  assert.equal(next.recommendation.taskId, laterId);
  assert.equal(next.recommendation.source, "ai", next.recommendation.warning);
  check("next task changes after completion using real AI");
  assert.equal((await call("/api/logout", { body: {} })).status, 200);
  assert.equal((await call("/api/tasks")).status, 401);
  check("logout revokes real session");
  console.log(
    `${passed} live integration checks passed. Google OAuth browser test remains separate.`,
  );
} finally {
  if (seeded) {
    await sql(
      `DELETE FROM ai_usage WHERE user_id IN ('${alice}','${bob}');DELETE FROM users WHERE id IN ('${alice}','${bob}');`,
    );
    console.log("Temporary test users, tasks and sessions removed.");
  }
}
