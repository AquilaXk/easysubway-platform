#!/usr/bin/env node
// 배포 후보 커밋에 번들된 server timetable snapshot evidence의 freshUntil을 컨테이너 재기동
// 없이 검사한다. 이미 만료됐거나, 배포 완료 예상 시점(now + margin) 안에 만료될 예정이면
// non-zero로 종료해 deploy-backend.sh가 기존 백엔드 컨테이너를 force-recreate 하기 전에
// 배포를 중단하도록 한다(이슈 #2330). freshUntil을 읽을 수 없거나 파싱에 실패하면 fail
// closed(non-zero)로 처리해, 검증 불가 상태에서 기존 서버를 교체하지 않는다.
//
// 중복 구현 사유: 상세 freshness 판정 로직(tools/datapack/check-timetable-snapshot-freshness.mjs,
// 이슈 #2333 / PR #2344)은 아직 미병합 브랜치에만 존재해 main 기반 배포 경로가 의존할 수
// 없다. 여기서는 배포 안전망에 필요한 "freshUntil이 마진 안에 만료되는가"만 판정하는 최소
// 구현으로 분리한다. #2333이 병합되면 후속 이슈에서 판정 로직을 단일 원본으로 통합할 수 있다.
//
// 사용: node tools/deploy/check-snapshot-freshness-precheck.mjs <evidence.json> [--margin-seconds N]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 배포 소요 상한(빌드 재기동·전파·헬스체크)에 대한 안전 마진. 이슈 #2330 DoD가 구체 값을
// 명시하지 않아, freshUntil이 "지금 + 이 마진" 안에 만료되면 새 컨테이너가 부팅 직후 또는
// 배포 완료 직후 fail closed로 죽는다고 보고 배포를 중단한다.
export const DEFAULT_MARGIN_SECONDS = 2 * 60 * 60; // 2h

export function evaluateSnapshotFreshnessPrecheck({
  freshUntil,
  now,
  marginSeconds = DEFAULT_MARGIN_SECONDS,
}) {
  // 안전망은 보호 대상 게이트(backend TimetableSeedLoader의 OffsetDateTime.parse,
  // 즉 offset 없는 timestamp를 거부)보다 관대해지면 안 된다: offset 없는 값을 Date.parse가
  // 러너 로컬 타임존으로 조용히 파싱해 통과시키는 것을 막는다.
  if (!/(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(String(freshUntil))) {
    throw new Error(`freshUntil must carry a timezone offset: ${String(freshUntil)}`);
  }
  const freshUntilMs = Date.parse(freshUntil);
  if (!Number.isFinite(freshUntilMs)) {
    throw new Error(`invalid freshUntil timestamp: ${String(freshUntil)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("now must be a valid Date");
  }
  if (!Number.isInteger(marginSeconds) || marginSeconds < 0) {
    throw new Error("marginSeconds must be a non-negative integer");
  }
  const nowMs = now.getTime();
  const deadlineMs = nowMs + marginSeconds * 1000;
  const remainingSeconds = Math.floor((freshUntilMs - nowMs) / 1000);
  const expired = freshUntilMs <= nowMs;
  // 마진 안에 만료 예정이면(이미 만료 포함) 배포를 중단해야 한다.
  const stale = freshUntilMs <= deadlineMs;
  return {
    freshUntil,
    freshUntilEpochSeconds: Math.floor(freshUntilMs / 1000),
    evaluatedAt: now.toISOString(),
    marginSeconds,
    remainingSeconds,
    expired,
    stale,
    ok: !stale,
  };
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--margin-seconds") {
      if (index + 1 >= argv.length) {
        throw new Error("--margin-seconds requires a value");
      }
      options.marginSeconds = argv[index += 1];
    } else if (token.startsWith("--margin-seconds=")) {
      options.marginSeconds = token.slice("--margin-seconds=".length);
    } else {
      positional.push(token);
    }
  }
  return { positional, options };
}

export async function runSnapshotFreshnessPrecheckCli({
  argv = process.argv.slice(2),
  now = new Date(),
  cwd = process.cwd(),
} = {}) {
  const { positional, options } = parseArgs(argv);
  const evidenceArg = positional[0];
  if (typeof evidenceArg !== "string" || evidenceArg.length === 0) {
    throw new Error("usage: check-snapshot-freshness-precheck.mjs <evidence.json> [--margin-seconds N]");
  }
  let marginSeconds = DEFAULT_MARGIN_SECONDS;
  if (options.marginSeconds !== undefined) {
    marginSeconds = Number(options.marginSeconds);
    if (!Number.isInteger(marginSeconds) || marginSeconds < 0) {
      throw new Error(`--margin-seconds must be a non-negative integer: ${String(options.marginSeconds)}`);
    }
  }
  const evidencePath = path.resolve(cwd, evidenceArg);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const freshUntil = evidence.freshUntil;
  if (typeof freshUntil !== "string") {
    throw new Error(`snapshot evidence at ${evidencePath} is missing freshUntil`);
  }
  const result = evaluateSnapshotFreshnessPrecheck({ freshUntil, now, marginSeconds });
  const verdict = result.ok ? "ok" : result.expired ? "expired" : "expiring_within_margin";
  console.log(
    `timetable snapshot freshness precheck: verdict=${verdict} freshUntil=${result.freshUntil} ` +
    `remainingSeconds=${result.remainingSeconds} marginSeconds=${result.marginSeconds} ` +
    `expired=${result.expired} stale=${result.stale}`,
  );
  return { result, exitCode: result.ok ? 0 : 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSnapshotFreshnessPrecheckCli()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      // 검증 불가·파싱 실패는 fail closed: 기존 서버를 건드리지 않고 배포를 중단시킨다.
      process.exitCode = 1;
    });
}
