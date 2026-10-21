// Creates the encryption key once. Existing credentials are never read or replaced.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
const wrangler = "node_modules/wrangler/bin/wrangler.js";
const { stdout } = await promisify(execFile)(
  process.execPath,
  [wrangler, "secret", "list"],
  { maxBuffer: 1024 * 1024 },
);
const start = stdout.indexOf("["),
  end = stdout.lastIndexOf("]");
if (start < 0 || end < start)
  throw Error("Could not inspect secret names. No changes made.");
const names = JSON.parse(stdout.slice(start, end + 1));
if (names.some((s) => s.name === "NOTION_ENCRYPTION_KEY")) {
  console.log("Notion encryption key already exists; left unchanged.");
} else {
  const child = spawn(
    process.execPath,
    [wrangler, "secret", "put", "NOTION_ENCRYPTION_KEY"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.end(randomBytes(32).toString("base64") + "\n");
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) process.exitCode = Number(code ?? 1);
}
