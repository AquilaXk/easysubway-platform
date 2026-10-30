import assert from "node:assert/strict";
import { readlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { deployObservabilityConfig, pollLive } from "./deploy-observability-config.mjs";
import {
  EPOCH0, PREVIOUS, PROBE_EXPIRY_SERIES, PROBE_SERIES, PROBE_SUCCESS_SERIES,
  base, clockOf, createHost, failureReceipt, sandbox, seedCurrentRelease, seedPreviousRelease, snapshot,
} from "./deploy-observability-config-fake-host.mjs";

// AquilaXk/easysubway-platform#270: 관측 설정 배포가 probe 시계열로 증명하는 것의 계약.
// 적용은 설정·규칙·target과 수렴 뒤 새로 scrape된 만료·성공 시계열이 모두 기대대로일 때만 통과한다(하나의 poll).
// 복원은 같은 poll로 설정을 대조하되 시계열은 복원한 probe가 scrape되었다는 증거(probe_success의 새 표본, 값은 무관)만 요구하고,
// 호스트 443에 달린 만료·성공 값은 externalSeries로 기록만 한다. 서버에 닿지 않아도(probe_success 0, 만료 시계열 없음) 복원은 두 번째 검증 창을 쓰지 않는다.

test("probe target이 up이어도 만료 시계열이나 probe 성공이 없으면 검증이 실패하고 직전 release로 복원한다", async () => {
  for (const missing of PROBE_SERIES) {
    const box = sandbox();
    try {
      seedPreviousRelease(box);
      const host = createHost({ missingSeries: [missing] });
      await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), (error) => error.code === "E_OBS_DEPLOY_VERIFY" && error.message.includes(`${missing} returned no sample`) && error.message.includes("restored previous release"), missing);
      assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS), missing);
      assert.equal(failureReceipt(box).restore, "RESTORED", missing);
    } finally {
      box.cleanup();
    }
  }
});

test("probe_success가 0이면 표본이 새것이어도 검증이 실패한다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ probeSuccessValue: "0" });
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), (error) => error.code === "E_OBS_DEPLOY_VERIFY" && error.message.includes(`${PROBE_SUCCESS_SERIES} is 0, expected 1`));
  } finally {
    box.cleanup();
  }
});

test("검증 창은 설정의 가장 긴 scrape 주기 두 배라 1m job의 첫 probe 시계열이 늦게 나와도 통과하고, 15s 설정에서 같은 지연은 실패한다", async () => {
  const slowFirstScrapeRounds = 30;
  const minute = sandbox();
  try {
    const host = createHost({ expected: snapshot({ jobScrapeInterval: "1m" }), seriesWarmupReads: slowFirstScrapeRounds });
    const result = await deployObservabilityConfig(base(minute, host, { mode: "DEPLOY" }));
    assert.equal(result.units.prometheus.action, "recreated");
    assert.ok(host.state.reads[PROBE_SUCCESS_SERIES] > slowFirstScrapeRounds);
  } finally {
    minute.cleanup();
  }
  const short = sandbox();
  try {
    const host = createHost({ seriesWarmupReads: slowFirstScrapeRounds });
    await assert.rejects(deployObservabilityConfig(base(short, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_VERIFY.*returned no sample/su);
  } finally {
    short.cleanup();
  }
});

// 재시작 전 마지막 scrape가 lookback 안에 남아 있으면 값이 맞아도 새 설정을 증명하지 못한다. 수렴이 끝난 뒤의 표본만 인정한다.
test("수렴 전 표본만 남아 있으면 검증 창 내내 새 표본을 기다리다 실패하고 직전 release로 복원한다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ staleSeriesReads: 1000 });
    await assert.rejects(
      deployObservabilityConfig(base(box, host, { mode: "DEPLOY", now: clockOf(host) })),
      (error) => error.code === "E_OBS_DEPLOY_VERIFY" && error.message.includes(`${PROBE_EXPIRY_SERIES} newest sample`) && error.message.includes("is not newer than the container convergence") && error.message.includes("restored previous release"),
    );
    assert.equal(host.state.reads[PROBE_EXPIRY_SERIES] >= 20, true, "검증 창 동안 다시 읽는다");
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS));
    const failure = failureReceipt(box);
    assert.equal(failure.restore, "RESTORED");
    assert.equal(failure.externalSeries.ok, true, "복원한 release의 probe는 새 표본을 낸다");
  } finally {
    box.cleanup();
  }
});

test("수렴 뒤 새 표본이 나오면 통과하고 receipt에 표본 시각과 값을 남긴다", async () => {
  const box = sandbox();
  try {
    const host = createHost({ staleSeriesReads: 7 });
    const result = await deployObservabilityConfig(base(box, host, { mode: "DEPLOY", now: clockOf(host) }));
    assert.equal(host.state.reads[PROBE_EXPIRY_SERIES], 8, "일곱 회차는 옛 표본을 보고 여덟 번째에 통과");
    assert.equal(result.verification.convergedAt, new Date((EPOCH0 + 5) * 1000).toISOString(), "compose up 한 번(5초) 뒤가 수렴 시각이다");
    assert.deepEqual(result.verification.liveSeries, [
      { series: PROBE_EXPIRY_SERIES, sampleTime: new Date((host.state.clock + 1) * 1000).toISOString(), value: "1728360" },
      { series: PROBE_SUCCESS_SERIES, sampleTime: new Date((host.state.clock + 1) * 1000).toISOString(), value: "1" },
    ]);
    assert.ok(host.state.clock + 1 > EPOCH0, "표본은 수렴 시각 뒤다");
  } finally {
    box.cleanup();
  }
});

// compose up(EPOCH0+5)과 probe 재시작(EPOCH0+10) 사이의 EPOCH0+7에 옛 설정으로 한 scrape도 수렴 시각(EPOCH0+10)보다 앞선 것이다.
// 수렴 시각을 compose up 앞이나 재시작 앞에서 재면 이 표본이 통과한다.
test("compose up과 probe 재시작 사이에 옛 설정으로 만든 표본은 인정하지 않는다", async () => {
  const box = sandbox();
  try {
    seedCurrentRelease(box);
    const host = createHost({ recreateOnUp: false, liveBefore: snapshot(), mountedBefore: "current", probeMountedBefore: "stale", staleSeriesReads: 1000, staleSampleAt: EPOCH0 + 7 });
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY", now: clockOf(host) })), /E_OBS_DEPLOY_VERIFY.*is not newer than the container convergence/su);
    assert.equal(host.calls.filter((call) => call.args[0] === "restart").length, 1, "probe만 재시작한다");
  } finally {
    box.cleanup();
  }
});

// 443에 닿는지는 release가 통제하지 못한다. 복원이 설정·규칙·target·마운트를 맞췄다면 복원 성공이고, probe 시계열은 결과로만 남는다.
test("외부 상태 때문에 probe 성공이 계속 0이면 직전 release에서도 같으므로 복원은 RESTORED이고 externalSeries만 ok false로 남는다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ probeSuccessValue: "0" });
    await assert.rejects(
      deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })),
      (error) => error.code === "E_OBS_DEPLOY_VERIFY" && error.message.includes("restored previous release") && error.message.includes(`${PROBE_SUCCESS_SERIES} is 0, expected 1`),
    );
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS));
    const failure = failureReceipt(box);
    assert.equal(failure.restore, "RESTORED");
    assert.equal(failure.error.code, "E_OBS_DEPLOY_VERIFY");
    assert.equal(failure.externalSeries.ok, false);
    assert.match(failure.externalSeries.detail, /probe_success.* is 0, expected 1.*route to host 443/u);
    assert.doesNotMatch(failure.externalSeries.detail, /no fresh sample/u, "표본은 새것이고 값만 나쁘다");
    assert.deepEqual(failure.externalSeries.series.map((reading) => [reading.series, reading.value]), [[PROBE_EXPIRY_SERIES, null], [PROBE_SUCCESS_SERIES, "0"]], "서버에 닿지 않으면 만료 시계열은 없다");
    assert.ok(host.state.reads[PROBE_SUCCESS_SERIES] >= 20, "적용 검증은 창을 다 기다린다");
    assert.deepEqual(host.state.restoreReads, { [PROBE_SUCCESS_SERIES]: 2, [PROBE_EXPIRY_SERIES]: 1 }, "복원은 scrape 증거를 한 번 확인하고 기록만 한다: 두 번째 창이 없다");
  } finally {
    box.cleanup();
  }
});

// 복원이 요구하는 것은 복원한 probe가 수렴 뒤 scrape되었다는 증거(probe_success의 새 표본, 값은 무관)다. 그것이 없으면 복원은 확인되지 않은 것이다.
test("복원한 probe의 probe_success가 수렴 뒤 새로 scrape되지 않으면 검증 창을 기다린 뒤 RESTORE 실패로 끝나고 만료 시계열은 요구하지 않는다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ probeSuccessValue: "0", restoreSeries: { staleReads: 1000 } });
    await assert.rejects(
      deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })),
      (error) => error.code === "E_OBS_DEPLOY_RESTORE" && error.message.includes("the restored probe is not being scraped") && error.message.includes(`${PROBE_SUCCESS_SERIES} newest sample`),
    );
    const failure = failureReceipt(box);
    assert.equal(failure.restore, "FAILED");
    assert.equal(failure.externalSeries, null);
    assert.ok(host.state.restoreReads[PROBE_SUCCESS_SERIES] >= 20, "scrape 증거를 검증 창 동안 기다린다");
    assert.equal(host.state.restoreReads[PROBE_EXPIRY_SERIES], undefined, "만료 시계열은 복원 판정에 읽지 않는다");
  } finally {
    box.cleanup();
  }
});

test("복원 뒤 만료 시계열 표본이 없거나 읽지 못해도 복원은 RESTORED이고 externalSeries가 원인 쪽을 구분해 남긴다", async () => {
  const cases = [
    ["새 표본 없음", { missing: [PROBE_EXPIRY_SERIES] }, /returned no sample.*no fresh sample/u, [[PROBE_EXPIRY_SERIES, null], [PROBE_SUCCESS_SERIES, "1"]]],
    ["읽기 실패", { unreadable: [PROBE_EXPIRY_SERIES] }, /live prometheus was not readable/u, [[PROBE_EXPIRY_SERIES, null], [PROBE_SUCCESS_SERIES, null]]],
  ];
  for (const [label, restoreSeries, detail, readings] of cases) {
    const box = sandbox();
    try {
      seedPreviousRelease(box);
      const host = createHost({ missingSeries: [PROBE_EXPIRY_SERIES], restoreSeries });
      await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_VERIFY.*restored previous release/su, label);
      const failure = failureReceipt(box);
      assert.equal(failure.restore, "RESTORED", label);
      assert.equal(failure.externalSeries.ok, false, label);
      assert.match(failure.externalSeries.detail, detail, label);
      assert.deepEqual(failure.externalSeries.series.map((reading) => [reading.series, reading.value]), readings, `${label}: 설정한 selector는 항상 남는다`);
    } finally {
      box.cleanup();
    }
  }
});

test("신선도 검사는 notBefore 없이는 시작하지 않는다", async () => {
  const series = [{ selector: PROBE_SUCCESS_SERIES, expectedValue: null, scrapeProof: true }];
  for (const freshness of [{ series }, { series, notBefore: Number.NaN }, undefined]) {
    await assert.rejects(pollLive({ docker: null, sleep: async () => {}, expected: snapshot(), flagKeys: [], freshness }), (error) => error.code === "E_OBS_DEPLOY_USAGE", JSON.stringify(freshness));
  }
});

test("외부 상태와 무관한 복원 검증(라이브 설정 대조)이 실패하면 E_OBS_DEPLOY_RESTORE다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ probeSuccessValue: "0", liveAfter: snapshot({ revision: "old" }), liveAfterRestore: snapshot({ revision: "unexpected" }) });
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_RESTORE.*restore verification/su);
    const failure = failureReceipt(box);
    assert.equal(failure.restore, "FAILED");
    assert.equal(failure.externalSeries, null);
  } finally {
    box.cleanup();
  }
});
