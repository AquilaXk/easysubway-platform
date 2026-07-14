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
    readiness: () => ({ status: 200, body: { status: "UP" } }),
    routeV1Search: () => ({ status: 403, body: {} }),
    routeV2Search: () => ({ status: 403, body: {} }),
    routeRefresh: () => ({ status: 404, body: {} }),
    adminLogin: () => ({ status: 200, body: "<html><body><form method=\"post\">login</form></body></html>", raw: true }),
    datapack: () => ({ status: 200, body: { packs: [{ id: "capital", version: "2026.07.01" }] } }),
  };
}

async function withServer(routes, fn) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let handler;
    if (url.pathname === "/actuator/health/readiness") handler = routes.readiness;
    else if (url.pathname === "/api/v1/routes/search" && req.method === "POST") handler = routes.routeV1Search;
    else if (url.pathname === "/api/v2/routes/search" && req.method === "POST") handler = routes.routeV2Search;
    else if (url.pathname === "/api/v2/routes/closure-probe/refresh" && req.method === "POST") handler = routes.routeRefresh;
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

async function runSmoke(baseUrl, extraArgs = []) {
  const dir = path.join(tmpdir(), `smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const reportPath = path.join(dir, "report.json");
  const args = [
    script,
    "--base-url",
    baseUrl,
    "--datapack-base-url",
    baseUrl,
    "--timeout-seconds",
    "4",
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

test("post-deploy smoke passes when all four axes respond correctly", async () => {
  await withServer(defaultRoutes(), async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 0);
    assert.equal(report.overall, "PASS");
    assert.equal(report.axes.length, 4);
    for (const id of ["readiness", "route-api-closure", "admin-login", "datapack"]) {
      assert.equal(axis(report, id).result, "PASS", `${id} should pass`);
    }
    assert.equal(axis(report, "datapack").deploymentAttributed, false);
    assert.equal(axis(report, "readiness").deploymentAttributed, true);
  });
});

test("post-deploy smoke accepts one-shot 403/404 for every closed route endpoint", async () => {
  const routes = defaultRoutes();
  await withServer(routes, async (baseUrl) => {
    const { code, report } = await runSmoke(baseUrl);
    assert.equal(code, 0);
    assert.equal(axis(report, "route-api-closure").result, "PASS");
    assert.equal(axis(report, "route-api-closure").attempts, 1);
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
  routes.routeV1Search = delayedForbidden;
  routes.routeV2Search = delayedForbidden;
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

  const { readiness, routeApiClosure, adminLogin, datapack } = contract.axes;
  assert.equal(readiness.deploymentAttributed, true);
  assert.equal(readiness.path, "/actuator/health/readiness");
  assert.equal(readiness.expectStatusValue, "UP");

  assert.equal(routeApiClosure.deploymentAttributed, true);
  assert.equal(routeApiClosure.id, "route-api-closure");
  assert.deepEqual(routeApiClosure.acceptedStatuses, [403, 404]);
  assert.deepEqual(
    routeApiClosure.endpoints.map(({ method, path: endpointPath }) => `${method} ${endpointPath}`),
    [
      "POST /api/v1/routes/search",
      "POST /api/v2/routes/search",
      "POST /api/v2/routes/closure-probe/refresh",
    ],
  );

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
