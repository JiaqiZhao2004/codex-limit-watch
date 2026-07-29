import assert from "node:assert/strict";
import test from "node:test";

import {
  formatLimit,
  parseArgs,
  selectWeeklyLimit,
} from "../bin/codex-weekly.js";

test("parses watch and one-shot options", () => {
  assert.deepEqual(parseArgs([]), {
    intervalSeconds: 60,
    json: false,
    once: false,
    clear: true,
  });
  assert.deepEqual(parseArgs(["--interval", "15", "--no-clear", "--once"]), {
    intervalSeconds: 15,
    json: false,
    once: true,
    clear: false,
  });
});

test("JSON output implies one-shot mode", () => {
  const options = parseArgs(["--json"]);
  assert.equal(options.json, true);
  assert.equal(options.once, true);
});

test("selects the exact weekly Codex window", () => {
  const limit = selectWeeklyLimit({
    rateLimits: {
      primary: {
        usedPercent: 12,
        windowDurationMins: 300,
        resetsAt: 1_800_000_000,
      },
      secondary: {
        usedPercent: 34,
        windowDurationMins: 10_080,
        resetsAt: 1_800_500_000,
      },
      planType: "plus",
    },
  });

  assert.equal(limit.windowName, "secondary");
  assert.equal(limit.usedPercent, 34);
  assert.equal(limit.remainingPercent, 66);
  assert.equal(limit.windowDurationMins, 10_080);
});

test("prefers the Codex bucket in a multi-limit response", () => {
  const limit = selectWeeklyLimit({
    rateLimitsByLimitId: {
      other: {
        limitId: "other",
        secondary: { usedPercent: 90, windowDurationMins: 10_080 },
      },
      codex: {
        limitId: "codex",
        limitName: "Codex",
        secondary: { usedPercent: 25, windowDurationMins: 10_080 },
      },
    },
  });

  assert.equal(limit.limitId, "codex");
  assert.equal(limit.remainingPercent, 75);
});

test("formats remaining usage and reset information", () => {
  const output = formatLimit(
    {
      limitName: "Codex",
      usedPercent: 25,
      remainingPercent: 75,
      resetsAt: 1_800_086_400,
      planType: "plus",
    },
    new Date(1_800_000_000 * 1000),
  );

  assert.match(output, /75% remaining/);
  assert.match(output, /25% used/);
  assert.match(output, /in 1d 0h/);
  assert.match(output, /Plan: plus/);
});
