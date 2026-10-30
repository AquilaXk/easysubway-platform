// platform#270: 관측 설정 배포가 라이브 Prometheus에서 읽은 시계열 표본의 신선도·값을 판정하는 순수 함수.
// 읽기(질의)는 deploy-observability-config.mjs가 맡고, 이 모듈은 읽은 표본을 해석만 한다.

export const isoOfEpoch = (seconds) => new Date(seconds * 1000).toISOString();

/** unit의 liveSeries 선언({metric, value?})을 selector를 가진 검증 대상으로 푼다. 값을 요구하지 않으면 expectedValue는 null이다. */
export const liveSeriesOf = (units) => units.flatMap((unit) => unit.liveSeries.map(({ metric, value = null }) => ({
  selector: `${metric}{job="${unit.job}"}`, expectedValue: value, scrapeProof: unit.scrapeProof === metric,
})));

/** 범위 질의 결과(시계열마다 [시각, 값] 쌍 목록)에서 가장 새 표본. 표본이 없으면 둘 다 null이다. */
export function newestSample(result) {
  const newest = result.flatMap(({ values }) => (values.length === 0 ? [] : [values.at(-1)])).reduce((best, pair) => (best === null || pair[0] > best[0] ? pair : best), null);
  return newest === null ? { sampleTime: null, value: null } : { sampleTime: Number(newest[0]), value: newest[1] };
}

/**
 * 수렴이 끝난 시각(notBefore, epoch 초) 뒤의 표본이 없는 시계열. 수렴 전 마지막 scrape가 lookback 안에 남아 있는 동안은
 * 값이 맞아도 새 설정을 증명하지 못하므로 stale이다.
 */
export const staleSeriesOf = (readings, notBefore) => readings.flatMap(({ selector, sampleTime }) => {
  if (sampleTime === null) return [`${selector} returned no sample`];
  return sampleTime > notBefore ? [] : [`${selector} newest sample ${isoOfEpoch(sampleTime)} is not newer than the container convergence at ${isoOfEpoch(notBefore)}`];
});

/** 표본은 있지만 기대한 값이 아닌 시계열. */
export const unhealthySeriesOf = (readings) => readings
  .filter(({ sampleTime, value, expectedValue }) => sampleTime !== null && expectedValue !== null && value !== expectedValue)
  .map(({ selector, value, expectedValue }) => `${selector} is ${value}, expected ${expectedValue}`);

export const seriesReceipt = (readings) => readings.map(({ selector, sampleTime, value }) => ({ series: selector, sampleTime: sampleTime === null ? null : isoOfEpoch(sampleTime), value }));

/**
 * 복원 뒤 외부 상태에 달린 시계열의 판정. 값이 기대와 다르면 exporter는 scrape되었으나 원 서버를 읽지 못한 것(route·TLS 쪽)이고,
 * 새 표본이 없으면 scrape·설정 쪽이다. 서버에 닿지 않으면 만료 시계열이 없는 것이 정상이라 값 문제가 있으면 신선도는 따지지 않는다.
 */
export function externalVerdict(readings, notBefore) {
  const unhealthy = unhealthySeriesOf(readings);
  if (unhealthy.length > 0) return { ok: false, detail: `${unhealthy.join("; ")} (the probe was scraped but did not read the origin certificate: check the route to host 443 and TLS)` };
  const stale = staleSeriesOf(readings, notBefore);
  if (stale.length > 0) return { ok: false, detail: `${stale.join("; ")} (no fresh sample: check the scrape and the config)` };
  return { ok: true, detail: "every series has a sample newer than the restore and the expected value" };
}
