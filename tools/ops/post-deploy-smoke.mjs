#!/usr/bin/env node
// Post-deploy smoke: verifies that the core user-facing flows actually answer at
// the deployed URL after a backend deploy (issue #1688). Four axes mirror the
// service structure: platform health, route search (north star), admin web, and
// the datapack distribution URL (independent OCI Object Storage infra).
//
// Design constraints (see issue #1688):
// - Respect the downgrade ladder: a non-realtime eta source (PLANNED/STATIC) is
//   NOT a failure. useRealtime is fixed to false so the gate never depends on a
//   flaky realtime provider.
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

function buildDepartureTime(axis, now = Date.now()) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(axis.departureUtcOffset);
  if (!match) throw new Error(`invalid departureUtcOffset: ${axis.departureUtcOffset}`);
  const sign = match[1] === "-" ? -1 : 1;
  const offsetSeconds = sign * (Number(match[2]) * 3600 + Number(match[3]) * 60);
  const local = new Date(now + offsetSeconds * 1000);
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}T${axis.departureLocalTime}${axis.departureUtcOffset}`;
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

async function checkRouteSearch(baseUrl, axis, timeoutMs) {
  const url = joinUrl(baseUrl, axis.path);
  const requestBody = { ...axis.request, departureTime: buildDepartureTime(axis) };
  const { status, text } = await httpRequest(url, {
    method: axis.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
    timeoutMs,
  });
  if (status !== 200) throw new Error(`route search returned HTTP ${status}`);
  const body = parseJson(text, "route search");
  if (body.success !== true) throw new Error("route search response.success was not true");
  const data = body.data;
  if (!data || data.contractVersion !== axis.expectedContractVersion) {
    throw new Error(`route search contractVersion was ${data?.contractVersion}, expected ${axis.expectedContractVersion}`);
  }
  const itineraries = data.itineraries;
  if (!Array.isArray(itineraries) || itineraries.length < axis.minItineraries) {
    throw new Error(`route search returned ${itineraries?.length ?? 0} itineraries, expected >= ${axis.minItineraries}`);
  }
  const legs = itineraries.flatMap((entry) => (Array.isArray(entry.legs) ? entry.legs : []));
  if (legs.length < 1) throw new Error("route search itineraries contained no legs");
  for (const leg of legs) {
    const label = leg[axis.legEtaSourceField];
    if (typeof label !== "string" || label.length === 0) {
      throw new Error(`route search leg is missing a ${axis.legEtaSourceField} label`);
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
  const { readiness, routeSearch, adminLogin, datapack } = contract.axes;

  const datapackBaseUrl = argValue(args, "--datapack-base-url", datapack.baseUrl);
  const budgetMs = Number(argValue(args, "--timeout-seconds", "90")) * 1000;

  const axes = [];
  axes.push(await runAxis(readiness, (t) => checkReadiness(baseUrl, readiness, t), {
    maxMs: Math.max(6000, budgetMs * 0.55),
    delayMs: 3000,
  }));
  axes.push(await runAxis(routeSearch, (t) => checkRouteSearch(baseUrl, routeSearch, t), {
    maxMs: Math.max(3000, budgetMs * 0.2),
    delayMs: 2000,
  }));
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
