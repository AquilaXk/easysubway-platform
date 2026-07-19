#!/usr/bin/env node
// Post-deploy smoke: verifies the deployed backend and the independent datapack
// URL after a deploy (issue #1688). The route axis proves that production route
// v1/refresh stay closed and Route V2 matches the deployed ingress toggle; it
// must never retry an observed 2xx or mismatched ingress status into a later PASS.
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

class RetryableTrainSmokeError extends Error {}

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

async function retry(check, { maxMs, delayMs, shouldRetry = () => true }) {
  const deadline = Date.now() + maxMs;
  let attempts = 0;
  let lastError;
  for (;;) {
    attempts += 1;
    try {
      await check(Math.max(1, deadline - Date.now()));
      return { ok: true, attempts, error: null };
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || Date.now() + delayMs >= deadline) {
        return { ok: false, attempts, error: lastError };
      }
      await sleep(delayMs);
    }
  }
}

function joinUrl(base, pathname) {
  return `${base.replace(/\/+$/, "")}${pathname}`;
}

async function checkHealth(baseUrl, axis, timeoutMs) {
  const url = joinUrl(baseUrl, axis.path);
  const { status, text } = await httpRequest(url, { timeoutMs });
  if (status !== 200) throw new Error(`${axis.id} returned HTTP ${status}`);
  const body = parseJson(text, axis.id);
  if (body[axis.expectStatusField] !== axis.expectStatusValue) {
    throw new Error(`${axis.id} ${axis.expectStatusField} was ${body[axis.expectStatusField]}, expected ${axis.expectStatusValue}`);
  }
}

async function checkRouteApiClosure(baseUrl, axis, timeoutMs, routeV2IngressEnabled) {
  const deadline = Date.now() + timeoutMs;
  for (const endpoint of axis.endpoints) {
    const context = `${endpoint.method} ${endpoint.path}`;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`${context} check failed: timeout budget exhausted`);
    let status;
    let text;
    try {
      ({ status, text } = await httpRequest(joinUrl(baseUrl, endpoint.path), {
        method: endpoint.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(endpoint.request),
        timeoutMs: remainingMs,
      }));
    } catch (error) {
      throw new Error(`${context} check failed: ${error.message}`, { cause: error });
    }
    const acceptedStatuses = endpoint.acceptedStatusesByIngress?.[String(routeV2IngressEnabled)]
      ?? endpoint.acceptedStatuses
      ?? axis.acceptedStatuses;
    if (!acceptedStatuses.includes(status)) {
      throw new Error(`${context} returned HTTP ${status}`);
    }
    const expectedJsonFields = endpoint.expectedJsonFieldsByIngress?.[String(routeV2IngressEnabled)];
    if (expectedJsonFields) {
      const body = parseJson(text, context);
      for (const [field, expected] of Object.entries(expectedJsonFields)) {
        if (body[field] !== expected) {
          throw new Error(`${context} ${field} was ${String(body[field])}, expected ${String(expected)}`);
        }
      }
    }
  }
}

function koreaServiceDay() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date()).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  const calendarDate = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) >= 3) return calendarDate;
  const prior = new Date(`${calendarDate}T00:00:00Z`);
  prior.setUTCDate(prior.getUTCDate() - 1);
  return prior.toISOString().slice(0, 10);
}

async function trainStations(baseUrl, axis, query, timeoutMs) {
  const url = new URL(joinUrl(baseUrl, axis.stationPath));
  url.searchParams.set("query", query);
  url.searchParams.set("trainType", axis.trainType);
  let status;
  let text;
  try {
    ({ status, text } = await httpRequest(url, { timeoutMs }));
  } catch (error) {
    throw new RetryableTrainSmokeError(`${query} station catalog request failed: ${error.message}`);
  }
  if (status === 503) throw new RetryableTrainSmokeError(`${query} station catalog returned HTTP 503`);
  if (status !== 200) throw new Error(`${query} station catalog returned HTTP ${status}`);
  const body = parseJson(text, `${query} station catalog`);
  if (body.success !== true || !Array.isArray(body.data)) {
    throw new Error(`${query} station catalog schema was invalid`);
  }
  const station = body.data.find((entry) => entry?.name === query && typeof entry.id === "string" && entry.id !== "");
  if (!station) throw new Error(`${query} station catalog did not contain the exact station`);
  return station;
}

async function checkTrainSearch(baseUrl, axis, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error("train search smoke timeout budget exhausted");
    return value;
  };
  const departure = await trainStations(baseUrl, axis, axis.stationQueries[0], remaining());
  const arrival = await trainStations(baseUrl, axis, axis.stationQueries[1], remaining());
  const url = new URL(joinUrl(baseUrl, axis.searchPath));
  url.searchParams.set("departureStationId", departure.id);
  url.searchParams.set("arrivalStationId", arrival.id);
  url.searchParams.set("departureDate", koreaServiceDay());
  url.searchParams.set("trainType", axis.trainType);
  let status;
  let text;
  try {
    ({ status, text } = await httpRequest(url, { timeoutMs: remaining() }));
  } catch (error) {
    throw new RetryableTrainSmokeError(`train search request failed: ${error.message}`);
  }
  if (status === 503) throw new RetryableTrainSmokeError("train search returned HTTP 503");
  if (status !== 200) throw new Error(`train search returned HTTP ${status}`);
  const body = parseJson(text, "train search");
  const journeys = body?.success === true && Array.isArray(body?.data?.outbound) ? body.data.outbound : [];
  const approved = journeys.some((journey) => (
    journey?.trainType === axis.trainType
      && journey?.departureStationId === departure.id
      && journey?.arrivalStationId === arrival.id
      && Number.isInteger(journey?.adultFareWon)
      && journey.adultFareWon >= 0
  ));
  if (!approved) throw new Error("train search did not return an approved Seoul-Daejeon KTX fare row");
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

function timeoutAxis(axis, startedAt) {
  return {
    id: axis.id,
    titleKo: axis.titleKo,
    deploymentAttributed: axis.deploymentAttributed,
    result: "FAIL",
    latencyMs: Date.now() - startedAt,
    attempts: 0,
    detail: "global timeout budget exhausted",
  };
}

async function runAxis(axis, check, options, globalDeadline) {
  const startedAt = Date.now();
  const globalRemainingMs = globalDeadline - startedAt;
  if (globalRemainingMs <= 0) return timeoutAxis(axis, startedAt);
  const maxMs = Math.min(options.maxMs, globalRemainingMs);
  const perRequestTimeout = Math.min(10000, Math.max(2000, maxMs));
  const outcome = await retry(
    (remainingMs) => check(Math.min(perRequestTimeout, remainingMs)),
    { ...options, maxMs },
  );
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

async function runAxisOnce(axis, check, timeoutMs, globalDeadline) {
  const startedAt = Date.now();
  const globalRemainingMs = globalDeadline - startedAt;
  if (globalRemainingMs <= 0) return timeoutAxis(axis, startedAt);
  try {
    await check(Math.min(timeoutMs, globalRemainingMs));
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
  const routeV2IngressEnabledRaw = argValue(args, "--route-v2-ingress-enabled");
  if (routeV2IngressEnabledRaw !== "true" && routeV2IngressEnabledRaw !== "false") {
    throw new Error("--route-v2-ingress-enabled must be true or false");
  }
  const routeV2IngressEnabled = routeV2IngressEnabledRaw === "true";

  const contractPath = argValue(args, "--contract", DEFAULT_CONTRACT);
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const { liveness, readiness, routeApiClosure, trainSearch, adminLogin, datapack } = contract.axes;

  const datapackBaseUrl = argValue(args, "--datapack-base-url", datapack.baseUrl);
  const budgetMs = Number(argValue(args, "--timeout-seconds", "90")) * 1000;
  const globalDeadline = Date.now() + budgetMs;

  const axes = [];
  axes.push(await runAxis(liveness, (t) => checkHealth(baseUrl, liveness, t), {
    maxMs: Math.max(2000, budgetMs * 0.1),
    delayMs: 2000,
  }, globalDeadline));
  axes.push(await runAxis(readiness, (t) => checkHealth(baseUrl, readiness, t), {
    maxMs: Math.max(6000, budgetMs * 0.45),
    delayMs: 3000,
  }, globalDeadline));
  axes.push(await runAxisOnce(
    routeApiClosure,
    (t) => checkRouteApiClosure(baseUrl, routeApiClosure, t, routeV2IngressEnabled),
    Math.min(10000, Math.max(2000, budgetMs * 0.2)),
    globalDeadline,
  ));
  axes.push(await runAxis(
    trainSearch,
    (t) => checkTrainSearch(baseUrl, trainSearch, t),
    {
      maxMs: Math.max(2000, budgetMs * 0.75),
      delayMs: 2000,
      shouldRetry: (error) => error instanceof RetryableTrainSmokeError,
    },
    globalDeadline,
  ));
  axes.push(await runAxis(adminLogin, (t) => checkAdminLogin(baseUrl, adminLogin, t), {
    maxMs: Math.max(2000, budgetMs * 0.1),
    delayMs: 2000,
  }, globalDeadline));
  if (datapackBaseUrl) {
    axes.push(await runAxis(datapack, (t) => checkDatapack(datapackBaseUrl, datapack, t), {
      maxMs: Math.max(2000, budgetMs * 0.15),
      delayMs: 2000,
    }, globalDeadline));
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
    routeV2IngressEnabled,
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
