import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

const port = Number(process.argv[2]);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Pass a valid port number to start Wrangler.");
}

const probe = createServer();
probe.once("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    process.exitCode = 1;
    return;
  }

  console.error(error);
  process.exitCode = 1;
});
probe.listen(port, "127.0.0.1", () => {
  probe.close(() => {
    mkdirSync(".wrangler/logs", { recursive: true });
    const registryPath = resolve(".wrangler/registry");
    const child = spawn(
      "pnpm",
      ["exec", "wrangler", "dev", "--ip", "127.0.0.1", "--port", String(port)],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          WRANGLER_LOG_PATH: ".wrangler/logs/wrangler.log",
          WRANGLER_REGISTRY_PATH: ".wrangler/registry",
          MINIFLARE_REGISTRY_PATH: registryPath,
        },
      },
    );

    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => child.kill(signal));
    }
    child.once("error", (error) => {
      console.error(error);
      process.exitCode = 1;
    });
    child.once("exit", (code, signal) => {
      process.exitCode = signal ? 1 : (code ?? 1);
    });
  });
});
