import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://chatwerk.esembe.app";
const MAX_ATTEMPTS = 6;
const RETRY_DELAYS_MS = [4_000, 8_000, 16_000, 32_000, 60_000];
const READINESS_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;

/**
 * Return whether Wrangler output describes a transient Cloudflare API failure.
 * Keep this independent of process state so the classification can be unit tested.
 * @param {string} output
 */
export function isTransientCloudflareFailure(output) {
  const text = String(output ?? "");

  return /\bD1 API error\b/i.test(text)
    || /\brequest to the Cloudflare API\b[^\r\n]*\bfailed\b/i.test(text)
    || /\bno healthy upstream\b/i.test(text)
    || /\b(?:invalid|malformed) API response\b|\b(?:invalid|malformed) response from (?:the )?API\b/i.test(text)
    || /\b(?:unexpected end of JSON input|invalid JSON response)\b/i.test(text)
    || /\bUnexpected token .{0,120} is not valid JSON\b/i.test(text)
    || /\b5\d\d\b/i.test(text);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.length === 1 && args[0] === "--dry-run";
  if (args.length > 0 && !dryRun) {
    throw new ScriptFailure("Usage: pnpm run deploy [--dry-run]", 2);
  }

  console.log("Building the production site once…");
  const buildEnv = { ...process.env, PUBLIC_ORIGIN: ORIGIN };
  delete buildEnv.CLOUDFLARE_API_TOKEN;
  delete buildEnv.CLOUDFLARE_ACCOUNT_ID;
  await runOnce("Production build", "pnpm", ["run", "build:production"], buildEnv);
  console.log("Production build: passed");

  if (dryRun) {
    console.log("\nDeploy dry run summary");
    console.log("- Production build: passed");
    console.log("- D1 migrations: skipped (dry run)");
    console.log("- Wrangler deploy: skipped (dry run)");
    console.log("- Live readiness and smoke checks: skipped (dry run)");
    console.log("No Cloudflare API or live-site requests were made.");
    return;
  }

  const expectedAssetPath = await readExpectedOverlayAssetPath();
  const migration = await runWithRetry(
    "D1 migrations",
    "pnpm",
    ["exec", "wrangler", "d1", "migrations", "apply", "chatwerk", "--remote"],
  );
  console.log(`D1 migrations: passed (attempt ${migration.attempts}/${MAX_ATTEMPTS})`);

  const deployment = await runWithRetry("Wrangler deploy", "pnpm", ["exec", "wrangler", "deploy"]);
  console.log(`Wrangler deploy: passed (attempt ${deployment.attempts}/${MAX_ATTEMPTS})`);

  console.log("Waiting for the deployed overlay and hashed asset…");
  let liveOverlay;
  try {
    liveOverlay = await waitForOverlayAssets(expectedAssetPath);
  } catch (error) {
    throw new SmokeCheckFailure(`The deploy itself went through, but live asset readiness failed: ${error.message}`);
  }

  const failures = await runSmokeChecks(liveOverlay);
  if (failures.length > 0) {
    throw new SmokeCheckFailure(`The deploy itself went through, but the smoke check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }

  console.log("\nDeploy summary");
  console.log("- Production build: passed");
  console.log(`- D1 migrations: passed (attempt ${migration.attempts}/${MAX_ATTEMPTS})`);
  console.log(`- Wrangler deploy: passed (attempt ${deployment.attempts}/${MAX_ATTEMPTS})`);
  console.log(`- Live asset readiness: passed (${expectedAssetPath})`);
  console.log("- Smoke check: passed (/overlay, unsigned Twitch webhook, /studio login redirect)");
}

async function runWithRetry(label, command, args) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await runProcess(command, args, process.env);
    if (result.code === 0) {
      writeCapturedOutput(result);
      return { attempts: attempt };
    }

    const output = `${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`;
    if (isTransientCloudflareFailure(output) && attempt < MAX_ATTEMPTS) {
      writeCapturedOutput(result);
      const delay = RETRY_DELAYS_MS[attempt - 1];
      console.error(`${label} hit a transient Cloudflare failure (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${delay / 1_000}s.`);
      await sleep(delay);
      continue;
    }

    writeCapturedOutput(result);
    const exitCode = childExitCode(result);
    throw new ScriptFailure(`${label} failed with exit code ${exitCode}.`, exitCode);
  }

  throw new ScriptFailure(`${label} stopped after ${MAX_ATTEMPTS} attempts.`, 1);
}

async function runOnce(label, command, args, env) {
  const result = await runProcess(command, args, env);
  writeCapturedOutput(result);
  if (result.code !== 0) {
    const exitCode = childExitCode(result);
    throw new ScriptFailure(`${label} failed with exit code ${exitCode}.`, exitCode);
  }
}

function runProcess(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let spawnError;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, error: spawnError }));
  });
}

function childExitCode(result) {
  if (typeof result.code === "number" && result.code !== 0) return result.code;
  return result.error ? 127 : 1;
}

function writeCapturedOutput(result) {
  if (result.stdout) process.stdout.write(redactSensitiveOutput(result.stdout));
  if (result.stderr) process.stderr.write(redactSensitiveOutput(result.stderr));
  if (result.error) process.stderr.write(`${redactSensitiveOutput(result.error.message)}\n`);
}

function redactSensitiveOutput(text) {
  let safeText = String(text);
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_API_TOKEN"]) {
    const value = process.env[name];
    if (value) safeText = safeText.replaceAll(value, "[REDACTED]");
  }
  return safeText
    .replace(/(\b(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|CF_API_TOKEN)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
}

async function readExpectedOverlayAssetPath() {
  const overlayHtml = await readFile(path.join(ROOT, "dist/client/overlay.html"), "utf8");
  const scriptAssets = hashedAssetPaths(overlayHtml).filter((assetPath) => /\.m?js$/iu.test(assetPath));
  if (scriptAssets.length === 0) {
    throw new ScriptFailure("Production build did not produce a hashed JavaScript asset for /overlay.", 1);
  }
  return scriptAssets[0];
}

function hashedAssetPaths(html) {
  const paths = [];
  for (const [, reference] of html.matchAll(/(?:src|href)=["']([^"']+)["']/giu)) {
    let url;
    try {
      url = new URL(reference, ORIGIN);
    } catch {
      continue;
    }
    if (url.origin === ORIGIN && url.pathname.startsWith("/assets/") && /-[\w-]{8,}\.[a-z0-9]+$/iu.test(url.pathname)) {
      paths.push(`${url.pathname}${url.search}`);
    }
  }
  return paths;
}

async function waitForOverlayAssets(expectedAssetPath) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let lastState = "no response";

  while (Date.now() < deadline) {
    const timeout = Math.max(1, Math.min(5_000, deadline - Date.now()));
    try {
      const pageResponse = await fetch(`${ORIGIN}/overlay`, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
      });
      if (pageResponse.status !== 200) {
        lastState = `/overlay returned HTTP ${pageResponse.status}`;
      } else {
        const html = await pageResponse.text();
        if (!hashedAssetPaths(html).includes(expectedAssetPath)) {
          lastState = `/overlay does not yet reference ${expectedAssetPath}`;
        } else {
          const assetResponse = await fetch(`${ORIGIN}${expectedAssetPath}`, {
            redirect: "manual",
            signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now()))),
          });
          if (assetResponse.status === 200) {
            await assetResponse.arrayBuffer();
            return { response: pageResponse, assetPath: expectedAssetPath };
          }
          lastState = `${expectedAssetPath} returned HTTP ${assetResponse.status}`;
        }
      }
    } catch (error) {
      lastState = `request failed (${error.name ?? "network error"})`;
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }

  throw new Error(`timed out after ${READINESS_TIMEOUT_MS / 1_000}s; last state: ${lastState}`);
}

async function runSmokeChecks(liveOverlay) {
  const failures = [];
  const overlayResponse = liveOverlay.response;
  if (overlayResponse.status !== 200) failures.push(`/overlay returned HTTP ${overlayResponse.status}`);
  const csp = overlayResponse.headers.get("content-security-policy") ?? "";
  if (/\bframe-ancestors\b/iu.test(csp)) failures.push("/overlay has a frame-ancestors directive");
  if (overlayResponse.headers.has("x-frame-options")) failures.push("/overlay has an X-Frame-Options header");

  try {
    const webhook = await fetch(`${ORIGIN}/webhooks/twitch`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (webhook.status !== 403) failures.push(`unsigned POST /webhooks/twitch returned HTTP ${webhook.status}, expected 403`);
  } catch (error) {
    failures.push(`POST /webhooks/twitch request failed (${error.name ?? "network error"})`);
  }

  try {
    const studio = await fetch(`${ORIGIN}/studio`, {
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    const location = studio.headers.get("location");
    const redirectsToLogin = location && new URL(location, ORIGIN).pathname === "/login";
    if (studio.status !== 302 || !redirectsToLogin) {
      failures.push(`/studio returned HTTP ${studio.status}, expected 302 to /login`);
    }
  } catch (error) {
    failures.push(`/studio request failed (${error.name ?? "network error"})`);
  }

  return failures;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class ScriptFailure extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = "ScriptFailure";
    this.exitCode = exitCode;
  }
}

class SmokeCheckFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeCheckFailure";
    this.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  });
}
