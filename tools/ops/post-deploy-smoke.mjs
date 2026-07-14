#!/usr/bin/env node
// Post-deploy smoke: verifies the deployed backend and the independent datapack
// URL after a deploy (issue #1688). The route axis proves that production route
// APIs stay closed; it must never retry an observed 2xx into a later PASS.
//
// Design constraints (see issue #1688):
// - The datapack axis is a DIFFERENT failure domain than the backend deploy; the
//   report labels each axis with `deploymentAttributed` so an operator can tell a
//   backend regression apart from an offline-data-supply outage.
// - No auto-rollback: a failure exits non-zero so the CD job fails and Slack
//   notifies; it does not revert an already-healthy container.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { argValue } from "../release/summary-validation-utils.mjs";

const DEFAULT_CONTRACT = path.join(import.meta.dirname, "post-deploy-smoke-contract.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpRequest(url, { method = "GET", body, headers = {}, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, body, headers, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, text };
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`request timed out after ${timeoutMs}ms`);
    throw new Error(error.message);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

async function retry(check, { maxMs, delayMs }) {
  const deadline = Date.now() + maxMs;
  let attempts = 0;
  let lastError;
  for (;;) {
    attempts += 1;
    try {
      await check();
      return { ok: true, attempts, error: null };
    } catch (error) {
      lastError = error;
      if (Date.now() + delayMs >= deadline) {
        return { ok: false, attempts, error: lastError };
      }
      await sleep(delayMs);
    }
  }
}

function joinUrl(base, pathname) {
  return `${base.replace(/\/+$/, "")}${pathname}`;
}

async function checkReadiness(baseUrl, axis, timeoutMs) {
  const url = joinUrl(baseUrl, axis.path);
  const { status, text } = await httpRequest(url, { timeoutMs });
  if (status !== 200) throw new Error(`readiness returned HTTP ${status}`);
  const body = parseJson(text, "readiness");
  if (body[axis.expectStatusField] !== axis.expectStatusValue) {
    throw new Error(`readiness ${axis.expectStatusField} was ${body[axis.expectStatusField]}, expected ${axis.expectStatusValue}`);
  }
}

async function checkRouteApiClosure(baseUrl, axis, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (const endpoint of axis.endpoints) {
    const context = `${endpoint.method} ${endpoint.path}`;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`${context} check failed: timeout budget exhausted`);
    let status;
    try {
      ({ status } = await httpRequest(joinUrl(baseUrl, endpoint.path), {
        method: endpoint.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(endpoint.request),
        timeoutMs: remainingMs,
      }));
    } catch (error) {
      throw new Error(`${context} check failed: ${error.message}`, { cause: error });
    }
    if (!axis.acceptedStatuses.includes(status)) {
      throw new Error(`${context} returned HTTP ${status}`);
    }
  }
}

async function checkAdminLogin(baseUrl, axis, timeoutMs) {
  const url = joinUrl(baseUrl, axis.path);
  const { status, text } = await httpRequest(url, { timeoutMs });
  if (status !== 200) throw new Error(`admin login returned HTTP ${status}`);
  const haystack = text.toLowerCase();
  const matched = axis.mustIncludeAny.some((needle) => haystack.includes(needle.toLowerCase()));
  if (!matched) throw new Error("admin login page did not contain a login form marker");
}

async function checkDatapack(datapackBaseUrl, axis, timeoutMs) {
  const url = joinUrl(datapackBaseUrl, axis.catalogPath);
  const { status, text } = await httpRequest(url, { timeoutMs });
  if (status !== 200) throw new Error(`datapack catalog returned HTTP ${status}`);
  const body = parseJson(text, "datapack catalog");
  const packs = body[axis.requiredArrayField];
  if (!Array.isArray(packs) || packs.length === 0) {
    throw new Error(`datapack catalog ${axis.requiredArrayField} was empty`);
  }
}

async function runAxis(axis, check, { maxMs, delayMs }) {
  const startedAt = Date.now();
  const perRequestTimeout = Math.min(10000, Math.max(2000, maxMs));
  const outcome = await retry(() => check(perRequestTimeout), { maxMs, delayMs });
  return {
    id: axis.id,
    titleKo: axis.titleKo,
    deploymentAttributed: axis.deploymentAttributed,
    result: outcome.ok ? "PASS" : "FAIL",
    latencyMs: Date.now() - startedAt,
    attempts: outcome.attempts,
    detail: outcome.ok ? "ok" : outcome.error.message,
  };
}

async function runAxisOnce(axis, check, timeoutMs) {
  const startedAt = Date.now();
  try {
    await check(timeoutMs);
    return {
      id: axis.id,
      titleKo: axis.titleKo,
      deploymentAttributed: axis.deploymentAttributed,
      result: "PASS",
      latencyMs: Date.now() - startedAt,
      attempts: 1,
      detail: "ok",
    };
  } catch (error) {
    return {
      id: axis.id,
      titleKo: axis.titleKo,
      deploymentAttributed: axis.deploymentAttributed,
      result: "FAIL",
      latencyMs: Date.now() - startedAt,
      attempts: 1,
      detail: error.message,
    };
  }
}

function renderTable(report) {
  const lines = [
    "| 축 | 결과 | 배포 기인 | latency(ms) | 시도 | 상세 |",
    "|---|---|---|---|---|---|",
  ];
  for (const axis of report.axes) {
    lines.push(
      `| ${axis.titleKo} | ${axis.result} | ${axis.deploymentAttributed ? "예" : "아니오(독립 인프라)"} | ${axis.latencyMs} | ${axis.attempts} | ${axis.detail} |`,
    );
  }
  lines.push("", `overall: **${report.overall}**`);
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const baseUrl = argValue(args, "--base-url");
  if (!baseUrl) throw new Error("--base-url is required");

  const contractPath = argValue(args, "--contract", DEFAULT_CONTRACT);
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const { readiness, routeApiClosure, adminLogin, datapack } = contract.axes;

  const datapackBaseUrl = argValue(args, "--datapack-base-url", datapack.baseUrl);
  const budgetMs = Number(argValue(args, "--timeout-seconds", "90")) * 1000;

  const axes = [];
  axes.push(await runAxis(readiness, (t) => checkReadiness(baseUrl, readiness, t), {
    maxMs: Math.max(6000, budgetMs * 0.55),
    delayMs: 3000,
  }));
  axes.push(await runAxisOnce(
    routeApiClosure,
    (t) => checkRouteApiClosure(baseUrl, routeApiClosure, t),
    Math.min(10000, Math.max(2000, budgetMs * 0.2)),
  ));
  axes.push(await runAxis(adminLogin, (t) => checkAdminLogin(baseUrl, adminLogin, t), {
    maxMs: Math.max(2000, budgetMs * 0.1),
    delayMs: 2000,
  }));
  if (datapackBaseUrl) {
    axes.push(await runAxis(datapack, (t) => checkDatapack(datapackBaseUrl, datapack, t), {
      maxMs: Math.max(2000, budgetMs * 0.15),
      delayMs: 2000,
    }));
  } else {
    axes.push({
      id: datapack.id,
      titleKo: datapack.titleKo,
      deploymentAttributed: datapack.deploymentAttributed,
      result: "SKIPPED",
      latencyMs: 0,
      attempts: 0,
      detail: "datapack base url not provided",
    });
  }

  const report = {
    schemaVersion: 1,
    gate: "post-deploy-smoke",
    generatedAt: new Date().toISOString(),
    baseUrl,
    datapackBaseUrl: datapackBaseUrl || null,
    overall: axes.some((axis) => axis.result === "FAIL") ? "FAIL" : "PASS",
    axes,
  };

  const reportPath = argValue(args, "--report");
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${renderTable(report)}\n`);

  if (report.overall !== "PASS") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
