#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface, emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_INTERVAL_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 20_000;
const FIVE_HOUR_MINUTES = 5 * 60;
const WEEK_MINUTES = 7 * 24 * 60;

export function parseArgs(argv) {
  const options = {
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    json: false,
    once: false,
    clear: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--once") {
      options.once = true;
    } else if (argument === "--json") {
      options.json = true;
      options.once = true;
    } else if (argument === "--no-clear") {
      options.clear = false;
    } else if (argument === "--interval") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--interval requires a number of seconds");
      }
      options.intervalSeconds = parsePositiveNumber(value, "--interval");
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return options;
}

function parsePositiveNumber(value, optionName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${optionName} must be a positive number`);
  }
  return number;
}

function collectLimitCandidates(response) {
  const snapshots = response?.rateLimitsByLimitId
    ? Object.values(response.rateLimitsByLimitId)
    : [];

  if (response?.rateLimits) {
    snapshots.push(response.rateLimits);
  }

  const uniqueSnapshots = [...new Set(snapshots)];
  const candidates = [];

  for (const snapshot of uniqueSnapshots) {
    if (!snapshot) {
      continue;
    }

    for (const [windowName, window] of [
      ["primary", snapshot.primary],
      ["secondary", snapshot.secondary],
    ]) {
      if (!window || !Number.isFinite(window.usedPercent)) {
        continue;
      }

      candidates.push({
        limitId: snapshot.limitId ?? null,
        limitName: snapshot.limitName ?? null,
        planType: snapshot.planType ?? null,
        reachedType: snapshot.rateLimitReachedType ?? null,
        windowName,
        usedPercent: clamp(window.usedPercent, 0, 100),
        remainingPercent: clamp(100 - window.usedPercent, 0, 100),
        resetsAt: window.resetsAt ?? null,
        windowDurationMins: window.windowDurationMins ?? null,
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error("Codex did not return a rate-limit window");
  }

  return candidates;
}

function selectLimitCandidate(
  candidates,
  durationMins,
  fallbackWindowName,
  required = true,
) {
  const exactDuration = candidates.filter(
    (candidate) => candidate.windowDurationMins === durationMins,
  );
  if (exactDuration.length > 0) {
    return preferCodexLimit(exactDuration);
  }

  const fallbackWindow = candidates.filter(
    (candidate) => candidate.windowName === fallbackWindowName,
  );
  if (fallbackWindow.length > 0) {
    const unlabeledFallback = fallbackWindow.filter(
      (candidate) => candidate.windowDurationMins === null,
    );
    if (unlabeledFallback.length > 0) {
      return preferCodexLimit(unlabeledFallback);
    }
  }

  if (!required) {
    return null;
  }

  throw new Error(
    `Codex did not return its ${durationMins}-minute rate-limit window`,
  );
}

export function selectRateLimits(response) {
  const candidates = collectLimitCandidates(response);
  return {
    fiveHour: selectLimitCandidate(
      candidates,
      FIVE_HOUR_MINUTES,
      "primary",
      false,
    ),
    weekly: selectLimitCandidate(candidates, WEEK_MINUTES, "secondary"),
  };
}

export function selectFiveHourLimit(response) {
  return selectRateLimits(response).fiveHour;
}

export function selectWeeklyLimit(response) {
  return selectRateLimits(response).weekly;
}

function preferCodexLimit(candidates) {
  return (
    candidates.find((candidate) => candidate.limitId === "codex") ??
    candidates[0]
  );
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function formatLimitWindow(label, limit, now) {
  if (!limit) {
    return [];
  }

  const resetDate = Number.isFinite(limit.resetsAt)
    ? new Date(limit.resetsAt * 1000)
    : null;
  const lines = [
    label,
    `${progressBar(limit.remainingPercent)}  ${limit.remainingPercent}% remaining · ${limit.usedPercent}% used`,
  ];

  if (resetDate && !Number.isNaN(resetDate.valueOf())) {
    lines.push(
      `Resets ${formatDate(resetDate)} (${formatRelative(resetDate, now)})`,
    );
  } else {
    lines.push("Reset time unavailable");
  }

  if (limit.reachedType) {
    lines.push(`Status: ${limit.reachedType}`);
  }

  return lines;
}

export function formatLimits(limits, now = new Date(), accountEmail = null) {
  const windows = [
    formatLimitWindow("5-hour limit", limits.fiveHour, now),
    formatLimitWindow("Weekly limit", limits.weekly, now),
  ].filter((window) => window.length > 0);
  const lines = ["Codex limits", "", ...windows.flatMap((window, index) =>
    index === 0 ? window : ["", ...window],
  )];
  const planType = limits.fiveHour?.planType ?? limits.weekly?.planType;

  if (accountEmail) {
    lines.push("", `Account: ${accountEmail}`);
  }
  if (planType) {
    if (!accountEmail) {
      lines.push("");
    }
    lines.push(`Plan: ${planType}`);
  }
  lines.push(`Updated ${formatDate(now)}`);
  return lines.join("\n");
}

export function formatSimpleLimit(limit, now = new Date(), updatedAt = now) {
  if (!limit) {
    return "";
  }

  const resetDate = Number.isFinite(limit.resetsAt)
    ? new Date(limit.resetsAt * 1000)
    : null;
  const updated = formatElapsed(updatedAt, now);
  const reset = resetDate && !Number.isNaN(resetDate.valueOf())
    ? `Resets ${formatRelative(resetDate, now)}`
    : "Reset time unavailable";

  return `${progressBar(limit.remainingPercent)}  ${limit.remainingPercent}% · Updated ${updated} · ${reset}`;
}

function progressBar(percent, width = 20) {
  const filled = Math.round((clamp(percent, 0, 100) / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function formatRelative(target, now) {
  let seconds = Math.max(0, Math.round((target - now) / 1000));
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);

  if (days > 0) {
    return `in ${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `in ${hours}h ${minutes}m`;
  }
  return `in ${minutes}m`;
}

function formatElapsed(start, end) {
  let seconds = Math.max(0, Math.round((end - start) / 1000));
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);

  if (days > 0) {
    return `${days}d ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  if (minutes > 0) {
    return `${minutes}m ago`;
  }
  return "just now";
}

class AppServerClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.process = null;
  }

  async start() {
    this.process = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.once("error", (error) => {
      this.rejectAll(new Error(`Could not start Codex: ${error.message}`));
    });
    this.process.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      this.rejectAll(
        new Error(
          `Codex app-server stopped with ${reason}${
            detail ? `: ${detail}` : ""
          }`,
        ),
      );
    });

    createInterface({ input: this.process.stdout }).on("line", (line) => {
      this.handleLine(line);
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex_limit_watch",
        title: "Codex Limit Watch",
        version: "0.2.0",
      },
    });
    this.notify("initialized", {});
  }

  request(method, params) {
    if (!this.process?.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }

    const id = this.nextId;
    this.nextId += 1;
    const message = { method, id };
    if (params !== undefined) {
      message.params = params;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method, params) {
    if (this.process?.stdin.writable) {
      this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id === undefined || !this.pending.has(message.id)) {
      return;
    }

    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(
        new Error(message.error.message ?? JSON.stringify(message.error)),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  stop() {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }
}

function printHelp() {
  console.log(`Usage: codex-usage [options]

Watch your Codex 5-hour and weekly usage limits. Refreshes every 60 seconds by default.

Options:
  --interval SECONDS  Set the refresh interval
  --once              Print once and exit
  --json              Print one machine-readable JSON result and exit
  --no-clear          Do not clear the terminal between refreshes
  Space               Switch between detailed and compact views while watching
  -h, --help          Show this help`);
}

function enableViewToggle(onToggle) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return () => {};
  }

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const onKeypress = (_input, key) => {
    if (key?.name === "c" && key.ctrl) {
      process.emit("SIGINT");
      return;
    }
    if (key?.name === "space") {
      onToggle();
    }
  };
  process.stdin.on("keypress", onKeypress);

  return () => {
    process.stdin.off("keypress", onKeypress);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`codex-usage: ${error.message}`);
    console.error("Run codex-usage --help for usage.");
    return 2;
  }

  if (options.help) {
    printHelp();
    return 0;
  }

  const client = new AppServerClient();
  let stopping = false;
  let wakeSleep = null;
  let simpleView = false;
  let latestLimits = null;
  let latestAccountEmail = null;
  let latestUpdatedAt = null;
  const render = () => {
    if (!latestLimits) {
      return;
    }
    if (options.clear && process.stdout.isTTY) {
      process.stdout.write("\x1B[2J\x1B[H");
    }
    if (simpleView) {
      const now = new Date();
      const lines = [
        formatSimpleLimit(latestLimits.fiveHour, now, latestUpdatedAt),
        formatSimpleLimit(latestLimits.weekly, now, latestUpdatedAt),
      ].filter(Boolean);
      process.stdout.write(lines.join("\n"));
    } else {
      console.log(formatLimits(latestLimits, latestUpdatedAt, latestAccountEmail));
      if (!options.once) {
        console.log(
          `\nRefreshing every ${options.intervalSeconds}s · Space to switch views · Ctrl-C to stop`,
        );
      }
    }
  };
  const disableViewToggle = options.once || options.json
    ? () => {}
    : enableViewToggle(() => {
        simpleView = !simpleView;
        render();
      });
  const stop = () => {
    stopping = true;
    client.stop();
    wakeSleep?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await client.start();

    do {
      try {
        const response = await client.request("account/rateLimits/read");
        latestLimits = selectRateLimits(response);
        try {
          const accountResponse = await client.request("account/read", {
            refreshToken: false,
          });
          latestAccountEmail = accountResponse?.account?.type === "chatgpt"
            ? accountResponse.account.email
            : null;
        } catch {
          latestAccountEmail = null;
        }
        latestUpdatedAt = new Date();

        if (options.json) {
          console.log(JSON.stringify(latestLimits));
        } else {
          render();
        }
      } catch (error) {
        console.error(
          `[${new Date().toLocaleTimeString()}] Could not read limit: ${
            error.message
          }`,
        );
        // Keep the last successful data visible while allowing the compact
        // view's "Updated ... ago" label to continue aging after failures.
        if (!options.once && !options.json && simpleView) {
          render();
        }
        if (options.once) {
          return 1;
        }
      }

      if (!options.once && !stopping) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            wakeSleep = null;
            resolve();
          }, options.intervalSeconds * 1000);
          wakeSleep = () => {
            clearTimeout(timer);
            wakeSleep = null;
            resolve();
          };
        });
      }
    } while (!options.once && !stopping);

    return 0;
  } catch (error) {
    console.error(`codex-usage: ${error.message}`);
    console.error(
      "Make sure the Codex CLI is installed and signed in (`codex login status`).",
    );
    return 1;
  } finally {
    disableViewToggle();
    client.stop();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const isEntryPoint =
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  process.exitCode = await main();
}
