import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const script = "tools/ops/post-deploy-smoke.mjs";

function defaultRoutes() {
  return {
    liveness: () => ({ status: 200, body: { status: "UP" } }),
    readiness: () => ({ status: 200, body: { status: "UP" } }),
    routeV1Search: () => ({ status: 403, body: {} }),
    routeV2Session: () => ({
      status: 403,
      body: { success: false, code: "ROUTE_SESSION_ATTESTATION_REJECTED", message: "ITX 시간표를 불러올 수 없어요" },
    }),
    routeV2Search: () => ({ status: 401, body: {} }),
    routeRefresh: () => ({ status: 404, body: {} }),
    trainSeoulStations: () => ({
      status: 200,
      body: { success: true, data: [{ id: "NAT010000", name: "서울" }] },
    }),
    trainDaejeonStations: () => ({
      status: 200,
      body: { success: true, data: [{ id: "NAT011668", name: "대전" }] },
    }),
    trainSearch: () => ({
      status: 200,
      body: {
        success: true,
        data: {
          observedAt: "2026-07-19T04:00:00Z",
          outbound: [{
            trainNumber: "001",
            trainType: "KTX",
            departureStationId: "NAT010000",
            departureStationName: "서울",
            departureAt: "2026-07-19T09:00:00+09:00",
            arrivalStationId: "NAT011668",
            arrivalStationName: "대전",
            arrivalAt: "2026-07-19T10:00:00+09:00",
            durationMinutes: 60,
            adultFareWon: 23700,
          }],
          inbound: [],
        },
      },
    }),
    adminLogin: () => ({ status: 200, body: "<html><body><form method=\"post\">login</form></body></html>", raw: true }),
    datapack: () => ({ status: 200, body: { packs: [{ id: "capital", version: "2026.07.01" }] } }),
  };
}

async function withServer(routes, fn) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let handler;
    if (url.pathname === "/actuator/health/liveness") handler = routes.liveness;
    else if (url.pathname === "/actuator/health/readiness") handler = routes.readiness;
    else if (url.pathname === "/api/v1/routes/search" && req.method === "POST") handler = routes.routeV1Search;
    else if (url.pathname === "/api/v2/routes/session" && req.method === "POST") handler = routes.routeV2Session;
    else if (url.pathname === "/api/v2/routes/search" && req.method === "POST") handler = routes.routeV2Search;
    else if (url.pathname === "/api/v2/routes/closure-probe/refresh" && req.method === "POST") handler = routes.routeRefresh;
    else if (url.pathname === "/api/v1/trains/stations" && url.searchParams.get("query") === "서울") handler = routes.trainSeoulStations;
    else if (url.pathname === "/api/v1/trains/stations" && url.searchParams.get("query") === "대전") handler = routes.trainDaejeonStations;
    else if (url.pathname === "/api/v1/trains/search") handler = routes.trainSearch;
    else if (url.pathname === "/admin/login") handler = routes.adminLogin;
    else if (url.pathname === "/catalog/current.json") handler = routes.datapack;

    if (!handler) {
      res.writeHead(404).end("not found");
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const out = await handler(Buffer.concat(chunks).toString("utf8"));
      const payload = out.raw ? out.body : JSON.stringify(out.body);
      res.writeHead(out.status, { "content-type": out.raw ? "text/html" : "application/json" }).end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runSmoke(baseUrl, extraArgs = [], timeoutSeconds = "4") {
  const dir = path.join(tmpdir(), `smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const reportPath = path.join(dir, "report.json");
  const ingressArgs = extraArgs.includes("--route-v2-ingress-enabled")
    ? []
    : ["--route-v2-ingress-enabled", "true"];
  const args = [
    script,
    "--base-url",
    baseUrl,
    "--datapack-base-url",
    baseUrl,
    "--timeout-seconds",
    timeoutSeconds,
    ...ingressArgs,
    "--report",
    reportPath,
    ...extraArgs,
  ];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: root });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    return { code: 0, stdout, report };
  } catch (error) {
    let report = null;
    try {
      report = JSON.parse(await readFile(reportPath, "utf8"));
    } catch {
      report = null;
    }
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "", report };
  }
}

function axis(report, id) {
  return report.axes.find((entry) => entry.id === id);
}

test("post-deploy smoke passes when all six axes respond correctly", async () => {
  await withServer(defaultRoutes(), async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 0);
    assert.equal(report.overall, "PASS");
    assert.equal(report.axes.length, 6);
    for (const id of ["liveness", "readiness", "route-api-closure", "train-search", "admin-login", "datapack"]) {
      assert.equal(axis(report, id).result, "PASS", `${id} should pass`);
    }
    assert.equal(axis(report, "datapack").deploymentAttributed, false);
    assert.equal(axis(report, "readiness").deploymentAttributed, true);
  });
});

test("post-deploy smoke retries a temporary train catalog 503 during cold start", async () => {
  const routes = defaultRoutes();
  let stationCalls = 0;
  routes.trainSeoulStations = () => {
    stationCalls += 1;
    return stationCalls === 1
      ? { status: 503, body: { success: false, data: { code: "TRAIN_SEARCH_UNAVAILABLE" } } }
      : { status: 200, body: { success: true, data: [{ id: "NAT010000", name: "서울" }] } };
  };
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 0);
    assert.equal(axis(report, "train-search").result, "PASS");
    assert.equal(axis(report, "train-search").attempts, 2);
    assert.equal(stationCalls, 2);
  });
});

test("post-deploy smoke does not retry a permanent train catalog 400", async () => {
  const routes = defaultRoutes();
  let stationCalls = 0;
  routes.trainSeoulStations = () => {
    stationCalls += 1;
    return { status: 400, body: { success: false, data: { code: "TRAIN_SEARCH_INVALID_ARGUMENT" } } };
  };
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 1);
    assert.equal(axis(report, "train-search").attempts, 1);
    assert.equal(stationCalls, 1);
  });
});

test("post-deploy smoke keeps every sequential axis inside one global timeout", async () => {
  const routes = defaultRoutes();
  routes.liveness = () => new Promise((resolve) => {
    setTimeout(() => resolve({ status: 200, body: { status: "UP" } }), 3000);
  });
  await withServer(routes, async (baseUrl) => {
    const startedAt = Date.now();
    const { code, report } = await runSmoke(baseUrl, [], "1");
    const elapsedMs = Date.now() - startedAt;

    assert.equal(code, 1);
    assert.ok(elapsedMs < 1800, `global timeout took ${elapsedMs}ms`);
    assert.equal(report.axes.length, 6);
    assert.match(axis(report, "train-search").detail, /global timeout budget exhausted/);
    assert.equal(axis(report, "train-search").attempts, 0);
  });
});

test("post-deploy smoke fails when nationwide train search cannot return a Seoul-Daejeon KTX fare", async () => {
  const routes = defaultRoutes();
  routes.trainSearch = () => ({
    status: 503,
    body: { success: false, data: { code: "TRAIN_SEARCH_UNAVAILABLE" } },
  });
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 1);
    assert.equal(axis(report, "train-search").result, "FAIL");
    assert.match(axis(report, "train-search").detail, /train search returned HTTP 503/);
  });
});

test("post-deploy smoke rejects a train result without an approved KTX fare row", async () => {
  const routes = defaultRoutes();
  routes.trainSearch = () => ({ status: 200, body: { success: true, data: { outbound: [] } } });
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 1);
    assert.match(axis(report, "train-search").detail, /approved Seoul-Daejeon KTX fare row/);
  });
});

test("post-deploy smoke fails when liveness is not UP", async () => {
  const routes = defaultRoutes();
  routes.liveness = () => ({ status: 503, body: { status: "DOWN" } });
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 1);
    assert.equal(axis(report, "liveness").result, "FAIL");
  });
});

test("post-deploy smoke accepts 401 for authenticated V2 search and keeps closed endpoints at 403/404", async () => {
  const routes = defaultRoutes();
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 0);
    assert.equal(axis(report, "route-api-closure").result, "PASS");
    assert.equal(axis(report, "route-api-closure").attempts, 1);
  });
});

test("post-deploy smoke requires enabled session ingress to reach exact attestation rejection", async () => {
  const routes = defaultRoutes();
  routes.routeV2Session = () => ({ status: 404, body: {} });
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 1);
    assert.match(axis(report, "route-api-closure").detail, /POST \/api\/v2\/routes\/session returned HTTP 404/);
  });

  routes.routeV2Session = () => ({ status: 403, body: { success: false, code: "WRONG_CODE" } });
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 1);
    assert.match(axis(report, "route-api-closure").detail, /code was WRONG_CODE/);
  });
});

test("post-deploy smoke rejects Play Integrity provider unavailability", async () => {
  const routes = defaultRoutes();
  routes.routeV2Session = () => ({
    status: 503,
    body: { success: false, code: "ROUTE_SESSION_ATTESTATION_UNAVAILABLE" },
  });
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 1);
    assert.match(axis(report, "route-api-closure").detail, /POST \/api\/v2\/routes\/session returned HTTP 503/);
  });
});

test("post-deploy smoke requires enabled ingress to return 401 instead of 404", async () => {
  const routes = defaultRoutes();
  routes.routeV2Search = () => ({ status: 404, body: {} });
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 1);
    assert.equal(axis(report, "route-api-closure").result, "FAIL");
    assert.match(axis(report, "route-api-closure").detail, /POST \/api\/v2\/routes\/search returned HTTP 404/);
  });
});

test("post-deploy smoke requires disabled ingress to return 404 instead of 401", async () => {
  const routes = defaultRoutes();
  routes.routeV2Session = () => ({ status: 404, body: {} });
  routes.routeV2Search = () => ({ status: 404, body: {} });
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl, ["--route-v2-ingress-enabled", "false"]);
    assert.equal(code, 0);
    assert.equal(axis(report, "route-api-closure").result, "PASS");
  });

  routes.routeV2Search = () => ({ status: 401, body: {} });
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl, ["--route-v2-ingress-enabled", "false"]);
    assert.equal(code, 1);
    assert.equal(axis(report, "route-api-closure").result, "FAIL");
    assert.match(axis(report, "route-api-closure").detail, /POST \/api\/v2\/routes\/search returned HTTP 401/);
  });
});

test("post-deploy smoke does not weaken v1 closure to 401", async () => {
  const routes = defaultRoutes();
  routes.routeV1Search = () => ({ status: 401, body: {} });
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 1);
    assert.equal(axis(report, "route-api-closure").result, "FAIL");
    assert.match(axis(report, "route-api-closure").detail, /POST \/api\/v1\/routes\/search returned HTTP 401/);
  });
});

test("post-deploy smoke fails immediately when any closed route endpoint returns 2xx", async () => {
  const routes = defaultRoutes();
  let calls = 0;
  routes.routeV2Search = () => {
    calls += 1;
    return calls === 1 ? { status: 200, body: { success: true } } : { status: 403, body: {} };
  };
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 1);
    assert.equal(report.overall, "FAIL");
    assert.equal(axis(report, "route-api-closure").result, "FAIL");
    assert.equal(axis(report, "route-api-closure").attempts, 1);
    assert.equal(calls, 1);
  });
});

test("post-deploy smoke shares one timeout budget across closed route endpoints", async () => {
  const routes = defaultRoutes();
  const delayedForbidden = () => new Promise((resolve) => {
    setTimeout(() => resolve({ status: 403, body: {} }), 900);
  });
  const delayedUnauthorized = () => new Promise((resolve) => {
    setTimeout(() => resolve({ status: 401, body: {} }), 900);
  });
  routes.routeV1Search = delayedForbidden;
  routes.routeV2Search = delayedUnauthorized;
  routes.routeRefresh = delayedForbidden;

  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 1);
    assert.equal(axis(report, "route-api-closure").result, "FAIL");
    assert.match(
      axis(report, "route-api-closure").detail,
      /POST \/api\/v2\/routes\/closure-probe\/refresh check failed/,
    );
  });
});

test("post-deploy smoke fails when readiness is not UP", async () => {
  const routes = defaultRoutes();
  routes.readiness = () => ({ status: 503, body: { status: "DOWN" } });
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 1);
    assert.equal(axis(report, "readiness").result, "FAIL");
  });
});

test("post-deploy smoke fails when datapack catalog has empty packs (independent infra, still attributed)", async () => {
  const routes = defaultRoutes();
  routes.datapack = () => ({ status: 200, body: { packs: [] } });
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 1);
    assert.equal(axis(report, "datapack").result, "FAIL");
    assert.equal(axis(report, "datapack").deploymentAttributed, false);
  });
});

test("post-deploy smoke fails fast when the base url is unreachable", async () => {
  // Reserve a port by binding then closing so nothing is listening.
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const { code, report } = await runSmoke(`http://127.0.0.1:${port}`);
  assert.equal(code, 1);
  assert.equal(report.overall, "FAIL");
  assert.equal(axis(report, "readiness").result, "FAIL");
});

test("post-deploy smoke contract file matches the expected schema", async () => {
  const contract = JSON.parse(await readFile(path.join(root, "tools/ops/post-deploy-smoke-contract.json"), "utf8"));
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.gate, "post-deploy-smoke");
  assert.equal(contract.issue, 1688);

  const { liveness, readiness, routeApiClosure, trainSearch, adminLogin, datapack } = contract.axes;
  assert.equal(liveness.deploymentAttributed, true);
  assert.equal(liveness.path, "/actuator/health/liveness");
  assert.equal(liveness.expectStatusValue, "UP");
  assert.equal(readiness.deploymentAttributed, true);
  assert.equal(readiness.path, "/actuator/health/readiness");
  assert.equal(readiness.expectStatusValue, "UP");

  assert.equal(routeApiClosure.deploymentAttributed, true);
  assert.equal(routeApiClosure.id, "route-api-closure");
  assert.deepEqual(routeApiClosure.acceptedStatuses, [403, 404]);
  const authenticatedV2Search = routeApiClosure.endpoints.find(
    ({ path: endpointPath }) => endpointPath === "/api/v2/routes/search",
  );
  assert.deepEqual(authenticatedV2Search.acceptedStatusesByIngress, {
    true: [401],
    false: [404],
  });
  const session = routeApiClosure.endpoints.find(
    ({ path: endpointPath }) => endpointPath === "/api/v2/routes/session",
  );
  assert.deepEqual(session.acceptedStatusesByIngress, {
    true: [403],
    false: [404],
  });
  assert.deepEqual(session.expectedJsonFieldsByIngress.true, {
    success: false,
    code: "ROUTE_SESSION_ATTESTATION_REJECTED",
  });
  assert.deepEqual(
    routeApiClosure.endpoints.map(({ method, path: endpointPath }) => `${method} ${endpointPath}`),
    [
      "POST /api/v1/routes/search",
      "POST /api/v2/routes/session",
      "POST /api/v2/routes/search",
      "POST /api/v2/routes/closure-probe/refresh",
    ],
  );

  assert.equal(trainSearch.deploymentAttributed, true);
  assert.equal(trainSearch.id, "train-search");
  assert.deepEqual(trainSearch.stationQueries, ["서울", "대전"]);
  assert.equal(trainSearch.searchPath, "/api/v1/trains/search");
  assert.equal(trainSearch.trainType, "KTX");

  assert.equal(adminLogin.deploymentAttributed, true);
  assert.equal(adminLogin.path, "/admin/login");
  assert.ok(Array.isArray(adminLogin.mustIncludeAny) && adminLogin.mustIncludeAny.length >= 1);

  // The datapack axis is an independent failure domain (OCI Object Storage).
  assert.equal(datapack.deploymentAttributed, false);
  assert.equal(datapack.catalogPath, "/catalog/current.json");
  assert.equal(datapack.requiredArrayField, "packs");
  // Same OCI value pinned by the repository contract test.
  assert.match(datapack.baseUrl, /^https:\/\/objectstorage\.ap-seoul-1\.oraclecloud\.com\/n\/axvym6vk8g7i\/b\/easysubway-datapacks\/o$/);
});

test("post-deploy smoke requires an explicit base url", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [script, "--datapack-base-url", "https://example.com"], { cwd: root }),
    /--base-url is required/,
  );
});

test("post-deploy smoke requires an explicit Route V2 ingress state", async () => {
  const error = await execFileAsync(
    process.execPath,
    [script, "--base-url", "https://example.invalid"],
    { cwd: root },
  ).then(() => null, (reason) => reason);
  assert.notEqual(error, null);
  assert.match(error.stderr, /--route-v2-ingress-enabled must be true or false/);
});
