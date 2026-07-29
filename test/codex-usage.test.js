import assert from "node:assert/strict";
import test from "node:test";

import {
  formatLimits,
  parseArgs,
  selectFiveHourLimit,
  selectRateLimits,
  selectWeeklyLimit,
} from "../bin/codex-usage.js";

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

test("selects the exact five-hour Codex window", () => {
  const limit = selectFiveHourLimit({
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

  assert.equal(limit.windowName, "primary");
  assert.equal(limit.usedPercent, 12);
  assert.equal(limit.remainingPercent, 88);
  assert.equal(limit.windowDurationMins, 300);
});

test("does not duplicate the weekly window when five-hour data is absent", () => {
  const limits = selectRateLimits({
    rateLimits: {
      primary: {
        usedPercent: 34,
        windowDurationMins: 10_080,
        resetsAt: 1_800_500_000,
      },
      secondary: null,
      planType: "plus",
    },
  });

  assert.equal(limits.fiveHour, null);
  assert.equal(limits.weekly.windowDurationMins, 10_080);
});

test("prefers the Codex bucket in a multi-limit response", () => {
  const limits = selectRateLimits({
    rateLimitsByLimitId: {
      other: {
        limitId: "other",
        primary: { usedPercent: 80, windowDurationMins: 300 },
        secondary: { usedPercent: 90, windowDurationMins: 10_080 },
      },
      codex: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 10, windowDurationMins: 300 },
        secondary: { usedPercent: 25, windowDurationMins: 10_080 },
      },
    },
  });

  assert.equal(limits.fiveHour.limitId, "codex");
  assert.equal(limits.fiveHour.remainingPercent, 90);
  assert.equal(limits.weekly.limitId, "codex");
  assert.equal(limits.weekly.remainingPercent, 75);
});

test("formats both limits and their reset information", () => {
  const output = formatLimits(
    {
      fiveHour: {
        usedPercent: 10,
        remainingPercent: 90,
        resetsAt: 1_800_003_600,
        planType: "plus",
      },
      weekly: {
        usedPercent: 25,
        remainingPercent: 75,
        resetsAt: 1_800_086_400,
        planType: "plus",
      },
    },
    new Date(1_800_000_000 * 1000),
  );

  assert.match(output, /5-hour limit/);
  assert.match(output, /90% remaining · 10% used/);
  assert.match(output, /in 1h 0m/);
  assert.match(output, /Weekly limit/);
  assert.match(output, /75% remaining/);
  assert.match(output, /25% used/);
  assert.match(output, /in 1d 0h/);
  assert.match(output, /Plan: plus/);
});

test("formats an unavailable five-hour window honestly", () => {
  const output = formatLimits({
    fiveHour: null,
    weekly: {
      usedPercent: 25,
      remainingPercent: 75,
      resetsAt: null,
      planType: "plus",
    },
  });

  assert.match(
    output,
    /5-hour limit\nUnavailable in current Codex response/,
  );
  assert.match(output, /Weekly limit/);
});
