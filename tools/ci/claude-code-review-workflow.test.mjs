import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Claude Code 공식 /code-review를 PR discovery 리뷰로 실행하는 workflow 계약 (#200, hub #3006 이식).
const workflow = readFileSync(new URL("../../.github/workflows/claude-code-review.yml", import.meta.url), "utf8");
const gateWorkflow = readFileSync(new URL("../../.github/workflows/automerge-queue.yml", import.meta.url), "utf8");

// 들여쓰기 0칸 최상위 키(on:, permissions:, jobs: ...) 사이의 블록을 잘라낸다.
const topLevelBlock = (key) => {
  const match = workflow.match(new RegExp(`^${key}:[^\\n]*\\n((?:(?:[ \\t][^\\n]*)?\\n)*)`, "m"));
  assert.ok(match, `${key}: 최상위 블록이 필요하다`);
  return match[1].replace(/\n+$/, "\n");
};
// jobs: 아래 2칸 들여쓰기 job 하나를 다음 job 직전까지 잘라낸다.
const jobBlock = (id) => {
  const start = workflow.search(new RegExp(`^ {2}${id}:\\n`, "m"));
  assert.ok(start >= 0, `${id} job이 필요하다`);
  const next = workflow.slice(start + 1).search(/^ {2}[A-Za-z_-]+:\n/m);
  return workflow.slice(start, next === -1 ? undefined : start + 1 + next);
};
const stepBlock = (name) => {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `${name} step이 필요하다`);
  const next = workflow.slice(start + 1).search(/\n(?: {6}- name: | {2}[A-Za-z_-]+:\n)/);
  return workflow.slice(start, next === -1 ? undefined : start + 1 + next);
};
const stepNames = (job) => [...jobBlock(job).matchAll(/^ {6}- name: ([^\n]+)$/gm)].map((match) => match[1]);
const jobPermissions = (job) => jobBlock(job).match(/^ {4}permissions:\n((?: {6}[^\n]*\n)+)/m)?.[1];
const jobTimeout = (job) => Number(jobBlock(job).match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]);

// claude[bot] 신원과 요약 개수 줄 판정은 workflow env 한 곳(CLAUDE_REVIEW_JQ_DEFS)에만 둔다(F5 필터 단일화).
const reviewDefs = workflow.match(/^env:\n {2}CLAUDE_REVIEW_JQ_DEFS: \|\n((?: {4}[^\n]*\n)+)/m)?.[1]?.replace(/^ {4}/gm, "");
const normalize = (text) => text.replace(/\s+/g, " ").trim();

// `run: |` 본문(10칸 들여쓰기)을 꺼내 gh·sleep·date 스텁과 함께 bash로 실제 실행한다.
const runBlockOf = (name) => {
  const run = stepBlock(name).match(/\n {8}run: \|\n((?:(?: {10}[^\n]*)?\n)+)/)?.[1];
  assert.ok(run, `${name} step에 run 블록이 필요하다`);
  return run.replace(/^ {10}/gm, "");
};
const GH_STUB = [
  "gh() {",
  '  printf "%s\\n" "gh $*" >> "$FIX/gh.log"',
  '  local all="$*" sha n last',
  '  case "$all" in',
  '    *"/reviews/"*"/comments"*) n="${all#*reviews/}"; n="${n%%/comments*}"; cat "$FIX/inline-$n.json" ;;',
  '    *"/pulls/"*"/reviews"*) cat "$FIX/reviews.json" ;;',
  '    *"/pulls/"*"/commits"*) cat "$FIX/commits.json" ;;',
  '    *"/pulls/"*) cat "$FIX/pr.json" ;;',
  '    *"/actions/workflows/claude-code-review.yml/runs?"*) sha="${all#*head_sha=}"; sha="${sha%%&*}"; cat "$FIX/claude-runs-$sha.json" ;;',
  '    *"/compare/"*) sha="${all#*...}"; sha="${sha%%\\?*}"; cat "$FIX/compare-$sha.json" ;;',
  '    *"/actions/runs?"*)',
  '      n=$(( $(cat "$FIX/ci-calls") + 1 )); printf "%s" "$n" > "$FIX/ci-calls"',
  '      last="$(cat "$FIX/ci-last")"; [ "$n" -le "$last" ] || n="$last"',
  '      cat "$FIX/ci-$n.json" ;;',
  '    *) printf "unstubbed gh call: %s\\n" "$all" >&2; return 1 ;;',
  "  esac",
  "}",
  'sleep() { printf "%s" "$(( $(cat "$FIX/clock") + $1 ))" > "$FIX/clock"; }',
  'date() { cat "$FIX/clock"; }',
].join("\n");
const runStep = (name, { env = {}, payloads = {}, ci = [], cwd } = {}) => {
  const fix = mkdtempSync(join(tmpdir(), "claude-review-step-"));
  const output = join(fix, "github-output");
  for (const [file, content] of [["github-output", ""], ["gh.log", ""], ["clock", "0"], ["ci-calls", "0"], ["ci-last", String(ci.length)]]) {
    writeFileSync(join(fix, file), content);
  }
  ci.forEach((payload, index) => writeFileSync(join(fix, `ci-${index + 1}.json`), JSON.stringify(payload)));
  for (const [file, payload] of Object.entries(payloads)) writeFileSync(join(fix, file), JSON.stringify(payload));
  const result = spawnSync("bash", ["-c", `${GH_STUB}\n${runBlockOf(name)}`], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FIX: fix, GITHUB_OUTPUT: output, CLAUDE_REVIEW_JQ_DEFS: reviewDefs ?? "", ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: readFileSync(output, "utf8"),
    calls: readFileSync(join(fix, "gh.log"), "utf8"),
    clock: Number(readFileSync(join(fix, "clock"), "utf8")),
    ciCalls: Number(readFileSync(join(fix, "ci-calls"), "utf8")),
  };
};
const outputOf = (result, key) => result.output.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const BASE = "c".repeat(40);
const CLAUDE = { login: "claude[bot]", id: 209825114, type: "Bot" };
const claudeReview = (id, overrides = {}) => ({
  id,
  state: "COMMENTED",
  commit_id: HEAD,
  submitted_at: "2026-09-29T01:05:00Z",
  author_association: "NONE",
  user: CLAUDE,
  body: "🔴 0 · 🟡 1 · 🟣 0\n요약",
  ...overrides,
});

test("트리거는 PR opened·ready_for_review·synchronize·reopened와 PR 번호 수동 재실행뿐이다", () => {
  const on = topLevelBlock("on");
  assert.match(on, /^ {2}pull_request:\n {4}types:\n {6}- opened\n {6}- ready_for_review\n {6}- synchronize\n {6}- reopened\n/m);
  assert.match(on, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}pr_number:\n(?: {8}[^\n]*\n)* {8}required: true\n(?: {8}[^\n]*\n)* {8}type: number\n/m);
  assert.doesNotMatch(on, /labeled|pull_request_target|push:|schedule:|issue_comment|pull_request_review/);
});

test("대상 판정 job과 리뷰 job으로 나뉘고 리뷰 job은 판정이 리뷰를 요구할 때만 돈다", () => {
  assert.deepEqual([...topLevelBlock("jobs").matchAll(/^ {2}([A-Za-z_-]+):\n/gm)].map((match) => match[1]), ["target", "review"]);
  // target: Resolve + run head 정합(D1(b)) + 재리뷰 판정(D8) + CI 대기(D4). 리뷰 에이전트·체크아웃은 없다.
  assert.deepEqual(stepNames("target"), ["Resolve pull request", "Check existing verified Claude review", "Wait for pull request CI"]);
  assert.match(jobBlock("target"), /^ {4}outputs:\n {6}should_review: \$\{\{ steps\.prior\.outputs\.should_review \}\}\n/m);
  // 이미 검증된 리뷰가 있으면 CI도 기다리지 않는다. target의 step-level 조건은 이것 하나다.
  assert.deepEqual(
    (jobBlock("target").match(/^ {8}if: [^\n]*$/gm) ?? []).map((line) => line.trim()),
    ["if: steps.prior.outputs.should_review == 'true'"],
  );
  assert.match(stepBlock("Wait for pull request CI"), /^ {8}if: steps\.prior\.outputs\.should_review == 'true'$/m);
  // review: checkout + 설정 복원(D6) + Review 스냅샷(D3) + action + 검증. 판정은 job 조건 하나로만 건너뛴다.
  const review = jobBlock("review");
  assert.match(review, /^ {4}needs: target\n/m);
  assert.match(review, /^ {4}if: needs\.target\.outputs\.should_review == 'true'\n/m);
  assert.deepEqual(stepNames("review"), [
    "Checkout pull request head",
    "Restore agent configuration from default branch",
    "Snapshot existing reviews",
    "Run Claude Code review",
    "Verify Claude review object",
  ]);
  assert.doesNotMatch(review, /^ {8}if:/m, "review job step에는 step-level if를 두지 않는다(가짜 통과 방지)");
  assert.match(review, /^ {4}name: Claude Code Review\n/m);
});

test("Draft·fork PR과 봇이 발생시킨 이벤트는 job-level if로 건너뛰고 수동 재실행은 영향받지 않는다", () => {
  const jobIf = jobBlock("target").match(/^ {4}if: (?:>-?\n)?([\s\S]*?)^ {4}runs-on:/m)?.[1];
  assert.ok(jobIf, "target job에 job-level if 조건이 필요하다");
  // action은 봇 actor를 거부한다. 판정 기준은 PR 작성자가 아니라 이 이벤트를 일으킨 sender다(D11).
  // 그래서 사람이 ready_for_review·dispatch한 봇 PR은 리뷰되고, 봇 push(synchronize)는 건너뛴다.
  assert.equal(
    normalize(jobIf),
    "(github.event_name == 'pull_request' && github.event.pull_request.draft == false && "
      + "github.event.pull_request.head.repo.full_name == github.repository && "
      + "github.event.sender.type != 'Bot') || github.event_name == 'workflow_dispatch'",
  );
  assert.doesNotMatch(workflow, /pull_request\.user\.type/);
  // skip된 job은 claude[bot] Review를 만들지 않으므로 게이트 통과가 아니다(automerge-queue.test.mjs의 marker·Review 없는 입력 → 거부).
});

test("수동 재실행도 open·non-draft·same-repo PR만 받고 run head가 PR head와 다르면 명시 실패한다", () => {
  const resolve = stepBlock("Resolve pull request");
  assert.match(resolve, /PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \|\| inputs\.pr_number \}\}/);
  assert.match(resolve, /EXPECTED_RUN_HEAD: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(resolve, /gh api "repos\/\$\{REPO\}\/pulls\/\$\{PR_NUMBER\}"/);
  // Review를 시간 창으로 찾지 않는다(D3). run 시작 시각은 더 이상 필요 없다.
  assert.doesNotMatch(workflow, /started_at|STARTED_AT|--arg since/);
  const checkout = stepBlock("Checkout pull request head");
  assert.match(checkout, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(checkout, /ref: \$\{\{ needs\.target\.outputs\.head_sha \}\}/);
  for (const output of ["number", "head_sha"]) {
    assert.match(jobBlock("target"), new RegExp(`^ {6}${output}: \\$\\{\\{ steps\\.pr\\.outputs\\.${output} \\}\\}$`, "m"));
  }

  const pr = (overrides = {}) => ({
    state: "open",
    draft: false,
    head: { sha: HEAD, ref: "feature-7", repo: { full_name: "o/r" } },
    base: { sha: BASE },
    ...overrides,
  });
  const env = { REPO: "o/r", PR_NUMBER: "7", EVENT_NAME: "pull_request", EXPECTED_RUN_HEAD: HEAD };
  const resolved = runStep("Resolve pull request", { env, payloads: { "pr.json": pr() } });
  assert.equal(resolved.status, 0, resolved.stdout + resolved.stderr);
  assert.equal(outputOf(resolved, "number"), "7");
  assert.equal(outputOf(resolved, "head_sha"), HEAD);
  assert.equal(outputOf(resolved, "head_ref"), "feature-7");
  assert.equal(outputOf(resolved, "base_sha"), BASE);
  assert.equal(
    runStep("Resolve pull request", { env: { ...env, EVENT_NAME: "workflow_dispatch" }, payloads: { "pr.json": pr() } }).status,
    0,
    "PR head 브랜치 ref로 dispatch한 run은 run head == PR head다",
  );

  for (const [overrides, reason] of [
    [{ state: "closed" }, "닫힌 PR"],
    [{ draft: true }, "Draft PR"],
    [{ head: { sha: HEAD, ref: "feature-7", repo: { full_name: "fork/r" } } }, "fork PR"],
  ]) {
    const result = runStep("Resolve pull request", { env, payloads: { "pr.json": pr(overrides) } });
    assert.equal(result.status, 1, reason);
    assert.match(result.stdout, /::error::/, reason);
  }

  // D1(b): 게이트는 Review commit에서 success로 끝난 run을 찾는다. run head가 PR head와 다르면 그 run의
  // Review는 게이트가 인정할 수 없으므로 리뷰하지 않고 명시 실패한다.
  const stalePush = runStep("Resolve pull request", { env: { ...env, EXPECTED_RUN_HEAD: OLD }, payloads: { "pr.json": pr() } });
  assert.equal(stalePush.status, 1);
  assert.match(stalePush.stdout, /::error::[^\n]*새 head의 synchronize run이 리뷰한다/);
  const defaultBranchDispatch = runStep("Resolve pull request", {
    env: { ...env, EVENT_NAME: "workflow_dispatch", EXPECTED_RUN_HEAD: OLD },
    payloads: { "pr.json": pr() },
  });
  assert.equal(defaultBranchDispatch.status, 1);
  assert.match(defaultBranchDispatch.stdout, /::error::[^\n]*gh workflow run claude-code-review\.yml --ref feature-7 -f pr_number=7/);
});

test("인증은 CLAUDE_CODE_OAUTH_TOKEN만 쓰고 API 키·커스텀 github_token을 쓰지 않는다", () => {
  const review = stepBlock("Run Claude Code review");
  assert.match(review, /uses: anthropics\/claude-code-action@[0-9a-f]{40} # v1\.0\.\d+\n/, "40자 커밋 SHA 고정 + 버전 주석");
  assert.doesNotMatch(workflow, /claude-code-action@v\d/, "움직이는 tag 참조 금지");
  assert.match(review, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /anthropic_api_key|ANTHROPIC_API_KEY/);
  assert.doesNotMatch(review, /github_token:/, "커스텀 토큰은 claude[bot]이 아닌 신원으로 게시하게 만든다");
  assert.deepEqual([...new Set(workflow.match(/secrets\.[A-Z0-9_]+/g))], ["secrets.CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.doesNotMatch(review, /track_progress: *["']?true/, "tag mode 전환 금지(agent mode prompt 유지)");
});

test("공식 /code-review를 high effort로 실행하고 ultra는 쓰지 않는다", () => {
  const review = stepBlock("Run Claude Code review");
  assert.match(review, /prompt: \/code-review high \$\{\{ needs\.target\.outputs\.number \}\}\n/);
  assert.doesNotMatch(workflow, /ultra/i);
});

test("Claude 도구 권한은 PR 조회, 작업 디렉터리 JSON 쓰기, 게시 전 중복 확인, 단일 COMMENT Review 게시로 제한된다", () => {
  const review = stepBlock("Run Claude Code review");
  const allowed = review.match(/--allowedTools "([^"]+)"/)?.[1];
  assert.ok(allowed, "--allowedTools가 필요하다");
  assert.deepEqual(allowed.split(","), [
    "Bash(gh pr view *)",
    "Bash(gh pr diff *)",
    "Edit(./claude-code-review.json)",
    "Bash(gh api repos/${{ github.repository }}/pulls/${{ needs.target.outputs.number }}/reviews)",
    "Bash(gh api repos/${{ github.repository }}/pulls/${{ needs.target.outputs.number }}/reviews --method POST --input claude-code-review.json)",
  ]);
  // D10: 공식 permissions 문서 — Edit 규칙은 파일을 편집하는 모든 내장 도구(Write 포함)에 적용되고,
  // Write 경로 규칙은 받아들여지지만 참조되지 않은 채 시작 경고만 남긴다. `./path`는 현재 디렉터리 기준이다.
  assert.doesNotMatch(allowed, /Write\(/, "Write 경로 규칙은 참조되지 않는 죽은 규칙이다");
  assert.doesNotMatch(allowed, /Edit\(\/claude-code-review\.json\)/, "`/path`는 settings source 기준 경로다");
  assert.match(review, /Write 도구로 \.\/claude-code-review\.json\(작업 디렉터리 기준\)에/, "프롬프트 경로 표현은 규칙과 같은 작업 디렉터리 기준이다");
  assert.match(review, /--append-system-prompt '/);
  assert.match(review, /"event": "COMMENT"/);
  assert.match(review, /"commit_id": "\$\{\{ needs\.target\.outputs\.head_sha \}\}"/);
  assert.match(review, /🔴 Important/);
  assert.match(review, /🟡 Nit/);
  assert.match(review, /🟣 Pre-existing/);
  assert.match(review, /한국어/);
  assert.match(review, /작성자\(사람, 에이전트, 자동화\)나 변경 크기와 관계없이[^\n]*건너뛰지 않는다/, "PR 작성자·크기 기반 skip 금지");
  assert.doesNotMatch(review, /--approve|--request-changes|Bash\(gh \*\)|Bash\(gh:\*\)|Bash\(\*\)|Bash\(gh api \*\)|Bash\(git push/);
});

test("게시 명령이 실패하면 다시 게시하기 전에 이번 head의 claude[bot] Review가 이미 생겼는지 확인한다", () => {
  // 서버는 POST를 처리했는데 클라이언트가 오류를 받은 경우 재시도가 Review를 두 벌 만든다(F4).
  const review = stepBlock("Run Claude Code review");
  assert.match(
    review,
    /게시 명령이 실패하면 다시 게시하기 전에 gh api repos\/\$\{\{ github\.repository \}\}\/pulls\/\$\{\{ needs\.target\.outputs\.number \}\}\/reviews로 head \$\{\{ needs\.target\.outputs\.head_sha \}\}에 대한 claude\[bot\] Review가 이미 생겼는지 확인한다\. 이미 있으면 다시 게시하지 않는다\./,
  );
  assert.doesNotMatch(review, /오류를 읽고 JSON을 고쳐 같은 명령을 다시 실행한다\. 성공한 뒤에는/, "무조건 재실행 지시는 남기지 않는다");
});

test("리뷰 프롬프트는 platform 저장소 규칙을 싣고 hub 전용 규칙을 옮겨 오지 않는다", () => {
  const review = stepBlock("Run Claude Code review");
  assert.match(review, /--append-system-prompt 'EasySubway platform PR discovery 리뷰 규칙 \(Issue #200\)\.\n/);
  for (const [priority, label] of [
    [/Fallback 금지: [^\n]*배포[^\n]*헬스[^\n]*실패를 성공으로 처리/, "Fallback 금지(배포·헬스 실패를 성공으로 처리 금지)"],
    [/비특권 실행[^\n]*NetworkPolicy[^\n]*이미지 digest 고정[^\n]*약화/, "비특권 실행·NetworkPolicy·이미지 digest 고정 약화"],
    [/공개 포트 바인딩 확대/, "공개 포트 바인딩 확대"],
    [/배포[^\n]*복구 게이트 약화: [^\n]*warning-only[^\n]*continue-on-error[^\n]*skip/, "배포·복구 게이트 약화"],
    [/버그 수정인데 수정 전에는 실패하는 테스트가 없음/, "RED 없는 버그 수정"],
    [/contracts\/documentation\/documentation-fragment\.json의 resources에 등록된 파일/, "문서 파편 미동기화"],
    [/시크릿[^\n]*API 키[^\n]*내부 절대경로[^\n]*운영 호스트 정보[^\n]*노출/, "시크릿·API 키·내부 절대경로·운영 호스트 정보 노출"],
  ]) {
    assert.match(review, priority, `platform 리뷰 규칙 누락: ${label}`);
  }
  // hub 전용(앱 라우팅·접근성 UI·Flyway) 규칙은 이 저장소 변경에 해당하지 않아 오탐 finding만 만든다.
  assert.doesNotMatch(review, /EasySubway hub|Issue #3006|서버 공인 라우팅|교통약자|Flyway/);
});

test("최소 권한·PR별 concurrency·timeout을 두고 실패를 성공으로 덮지 않는다", () => {
  assert.equal(topLevelBlock("permissions"), "  contents: read\n");
  // target은 CI run 대기(D4)·이전 검증 run 조회(D8)에 actions: read, compare 조회에 contents: read만 쓴다.
  assert.equal(jobPermissions("target"), "      contents: read\n      pull-requests: read\n      actions: read\n");
  // review만 OIDC(id-token)로 claude[bot] 토큰을 받는다. actions 권한은 필요 없다.
  assert.equal(jobPermissions("review"), "      contents: read\n      pull-requests: read\n      id-token: write\n");
  assert.doesNotMatch(workflow, /write-all|contents: write|pull-requests: write|issues: write|actions: write/);
  assert.match(topLevelBlock("concurrency"), /group: claude-code-review-\$\{\{ github\.event\.pull_request\.number \|\| inputs\.pr_number \}\}\n/);
  for (const job of ["target", "review"]) {
    const timeout = jobTimeout(job);
    assert.ok(timeout > 0 && timeout <= 60, `${job} timeout-minutes는 1~60이어야 한다: ${timeout}`);
  }
  assert.doesNotMatch(workflow, /^\s*continue-on-error\s*:/m);
  assert.doesNotMatch(workflow, /\|\| true|\|\| echo|\|\| exit 0/);
});

test("checkout은 git 자격 증명을 남기지 않는다", () => {
  // 이 job은 git 인증이 필요 없다. 남겨 두면 리뷰 에이전트가 쓰는 작업 디렉터리에 토큰이 남는다(D9).
  assert.match(stepBlock("Checkout pull request head"), /\n {10}persist-credentials: false\n/);
});

test("PR이 통제하는 에이전트 설정은 action 전에 지우고 기본 브랜치 것만 되살린다", () => {
  const names = stepNames("review");
  const restoreAt = names.indexOf("Restore agent configuration from default branch");
  assert.ok(restoreAt > names.indexOf("Checkout pull request head"), "checkout 뒤에 와야 한다");
  assert.ok(restoreAt < names.indexOf("Run Claude Code review"), "action보다 앞에 와야 한다");
  const restore = stepBlock("Restore agent configuration from default branch");
  assert.match(restore, /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  for (const path of [".claude", "CLAUDE.md", "CLAUDE.local.md", ".mcp.json"]) {
    assert.ok(restore.includes(path), `${path}를 다뤄야 한다`);
  }

  // 실제 git 저장소에서 step을 돌려 PR head의 설정이 기본 브랜치 것으로 바뀌는지 본다.
  const root = mkdtempSync(join(tmpdir(), "claude-review-config-"));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" });
  const origin = join(root, "origin");
  mkdirSync(join(origin, ".claude"), { recursive: true });
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "CLAUDE.md"), "base rules\n");
  writeFileSync(join(origin, ".claude", "settings.json"), "{\"base\":true}\n");
  writeFileSync(join(origin, "app.txt"), "base\n");
  git(origin, "add", "CLAUDE.md", ".claude/settings.json", "app.txt");
  git(origin, "commit", "-q", "-m", "base");
  git(origin, "checkout", "-q", "-b", "feature");
  mkdirSync(join(origin, ".claude", "agents"), { recursive: true });
  writeFileSync(join(origin, "CLAUDE.md"), "PR이 바꾼 지시\n");
  writeFileSync(join(origin, "CLAUDE.local.md"), "PR이 추가한 지시\n");
  writeFileSync(join(origin, ".mcp.json"), "{\"mcpServers\":{}}\n");
  writeFileSync(join(origin, ".claude", "settings.json"), "{\"pr\":true}\n");
  writeFileSync(join(origin, ".claude", "agents", "evil.md"), "evil\n");
  writeFileSync(join(origin, "app.txt"), "pr change\n");
  git(origin, "add", "CLAUDE.md", "CLAUDE.local.md", ".mcp.json", ".claude", "app.txt");
  git(origin, "commit", "-q", "-m", "pr");
  const work = join(root, "work");
  git(root, "clone", "-q", "--depth=1", "--branch", "feature", `file://${origin}`, work);

  const result = runStep("Restore agent configuration from default branch", { env: { DEFAULT_BRANCH: "main" }, cwd: work });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const read = (path) => readFileSync(join(work, path), "utf8");
  const exists = (path) => spawnSync("test", ["-e", join(work, path)]).status === 0;
  assert.equal(read("CLAUDE.md"), "base rules\n", "PR이 바꾼 CLAUDE.md는 기본 브랜치 것으로 되돌린다");
  assert.equal(read(".claude/settings.json"), "{\"base\":true}\n", ".claude/는 기본 브랜치 것으로 되돌린다");
  assert.equal(exists(".claude/agents/evil.md"), false, "PR이 추가한 .claude/ 파일은 남지 않는다");
  assert.equal(exists("CLAUDE.local.md"), false, "기본 브랜치에 없는 CLAUDE.local.md는 지운다");
  assert.equal(exists(".mcp.json"), false, "기본 브랜치에 없는 .mcp.json은 지운다");
  assert.equal(read("app.txt"), "pr change\n", "리뷰 대상 코드는 PR head 그대로다");
});

test("리뷰 전에 같은 head의 다른 pull_request workflow가 최신 run 기준으로 모두 green이기를 기다린다", () => {
  const wait = stepBlock("Wait for pull request CI");
  assert.match(wait, /gh api "repos\/\$\{REPO\}\/actions\/runs\?head_sha=\$\{HEAD_SHA\}&per_page=100"/);
  assert.match(wait, /HEAD_REF: \$\{\{ steps\.pr\.outputs\.head_ref \}\}/);
  const deadline = Number(wait.match(/^ {10}deadline=(\d+)$/m)?.[1]);
  assert.ok(deadline > 0 && deadline + 300 <= jobTimeout("target") * 60, `CI 대기 상한(${deadline}s)은 target job timeout 안이어야 한다`);

  const env = { REPO: "o/r", PR_NUMBER: "7", HEAD_SHA: HEAD, HEAD_REF: "feature-7" };
  const workflowIds = { "claude-code-review": 1, ci: 2, lint: 3, docs: 4, "automerge-queue": 5 };
  const run = (name, status, conclusion, overrides = {}) => ({
    name,
    workflow_id: workflowIds[name],
    run_number: 1,
    path: `.github/workflows/${name}.yml`,
    event: "pull_request",
    status,
    conclusion,
    head_sha: HEAD,
    ...overrides,
  });
  const runs = (...list) => ({ total_count: list.length, workflow_runs: list });
  const self = run("claude-code-review", "in_progress", null);
  const ciGreen = run("ci", "completed", "success");
  const waited = (ci) => runStep("Wait for pull request CI", { env, ci });

  const green = waited([runs(self, ciGreen)]);
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.equal(green.ciCalls, 1);

  const pendingThenGreen = waited([runs(self, run("ci", "in_progress", null)), runs(self, ciGreen)]);
  assert.equal(pendingThenGreen.status, 0, pendingThenGreen.stdout);
  assert.equal(pendingThenGreen.ciCalls, 2, "완료될 때까지 다시 조회한다");
  assert.equal(pendingThenGreen.clock, 30, "30초 간격으로 기다린다");

  assert.equal(
    waited([runs(self, ciGreen, run("lint", "completed", "skipped"), run("docs", "completed", "neutral"))]).status,
    0,
    "skipped·neutral은 실패가 아니다",
  );

  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "startup_failure"]) {
    const failed = waited([runs(self, run("ci", "completed", conclusion))]);
    assert.equal(failed.status, 1, `최신 run이 ${conclusion}이면 리뷰를 시작하지 않는다`);
    assert.match(failed.stdout, /::error::[^\n]*gh workflow run claude-code-review\.yml --ref feature-7 -f pr_number=7/);
  }

  // concurrency로 대체된 이전 run(cancelled)은 무시하고 workflow별 최신 run만 판정한다.
  assert.equal(
    waited([runs(self, run("ci", "completed", "cancelled", { run_number: 8541 }), run("ci", "completed", "success", { run_number: 8542 }))]).status,
    0,
    "대체된 cancelled run은 CI 실패가 아니다",
  );
  assert.equal(
    waited([runs(self, run("ci", "completed", "success", { run_number: 8541 }), run("ci", "completed", "cancelled", { run_number: 8542 }))]).status,
    1,
    "최신 run이 cancelled면 실패다",
  );
  const rerunning = waited([
    runs(self, run("ci", "completed", "failure", { run_number: 1 }), run("ci", "in_progress", null, { run_number: 2 })),
    runs(self, run("ci", "completed", "failure", { run_number: 1 }), run("ci", "completed", "success", { run_number: 2 })),
  ]);
  assert.equal(rerunning.status, 0, "새 run이 진행 중이면 이전 실패가 아니라 새 run을 기다린다");
  assert.equal(rerunning.ciCalls, 2);

  assert.equal(
    waited([runs(self, ciGreen, run("automerge-queue", "completed", "failure", { event: "pull_request_review" }))]).status,
    0,
    "pull_request가 아닌 이벤트의 run은 CI 판정에서 뺀다",
  );

  const selfOnly = waited([runs(self)]);
  assert.equal(selfOnly.status, 0, "이 workflow 자신만 보이면 기다린 뒤 진행한다");
  assert.ok(selfOnly.clock >= 120, "run이 하나도 안 보이면 최소 2분은 기다린다");
  assert.equal(
    waited([runs(run("claude-code-review", "completed", "failure", { run_number: 2 }), self, ciGreen)]).status,
    0,
    "이 workflow의 다른 run은 CI가 아니다",
  );

  const lateCi = waited([runs(self), runs(self, ciGreen)]);
  assert.equal(lateCi.status, 0);
  assert.equal(lateCi.ciCalls, 2, "run이 늦게 보이면 다시 조회해 기다린다");

  const stuck = waited([runs(self, run("ci", "queued", null))]);
  assert.equal(stuck.status, 1, "대기 상한을 넘기면 실패한다");
  assert.match(stuck.stdout, /::error::/);

  const overflow = waited([{ total_count: 101, workflow_runs: Array.from({ length: 100 }, () => ciGreen) }]);
  assert.equal(overflow.status, 1, "한 페이지를 넘는 run 목록은 판정하지 않는다");
});

test("claude[bot] 신원과 요약 개수 줄 정의는 한 곳에 두고 게이트와 같다", () => {
  assert.ok(reviewDefs, "workflow env CLAUDE_REVIEW_JQ_DEFS가 필요하다");
  const gateDefs = gateWorkflow.match(/claude_review_defs='\n([\s\S]*?)\n\s*'\n/)?.[1];
  assert.ok(gateDefs, "automerge-queue.yml에 claude_review_defs가 필요하다");
  // 한쪽만 바뀌면 검증 step과 게이트가 서로 다른 Review를 본다(F5).
  assert.equal(normalize(reviewDefs), normalize(gateDefs));
  assert.match(reviewDefs, /def is_claude:\s+\.author_association == "NONE" and\s+\.user\.login == "claude\[bot\]" and\s+\.user\.id == 209825114 and\s+\.user\.type == "Bot";/);
  assert.ok(reviewDefs.includes('capture("^🔴 (?<red>[0-9]+) · 🟡 (?<nit>[0-9]+) · 🟣 (?<pre>[0-9]+)$")'));
  // 신원 상수는 이 정의 밖에 다시 쓰지 않는다.
  assert.equal(workflow.match(/209825114/g)?.length, 1);
  assert.equal(workflow.match(/"claude\[bot\]"/g)?.length, 1);
});

test("synchronize·reopened는 PR commit 안에 검증된 claude[bot] Review가 이미 있으면 리뷰를 건너뛴다", () => {
  const prior = stepBlock("Check existing verified Claude review");
  assert.match(prior, /\n {8}id: prior\n/);
  assert.doesNotMatch(prior, /^ {8}if:/m);
  assert.match(prior, /EVENT_ACTION: \$\{\{ github\.event\.action \}\}/);
  assert.match(prior, /BASE_SHA: \$\{\{ steps\.pr\.outputs\.base_sha \}\}/);
  // 게이트(D1)와 같은 신원·개수 줄 정의로 후보를 고른다.
  assert.match(prior, /"\$\{CLAUDE_REVIEW_JQ_DEFS\}"'/);
  assert.match(prior, /select\(is_claude and \.state == "COMMENTED" and has_claude_count_line\)/);

  const name = "Check existing verified Claude review";
  const env = { REPO: "o/r", PR_NUMBER: "7", BASE_SHA: BASE, EVENT_NAME: "pull_request", EVENT_ACTION: "synchronize" };
  const success = (sha) => ({ total_count: 1, workflow_runs: [{ head_sha: sha, status: "completed", conclusion: "success" }] });
  const payloads = (overrides = {}) => ({
    "reviews.json": [[claudeReview(1, { commit_id: OLD })]],
    "commits.json": [[{ sha: OLD }, { sha: HEAD }]],
    [`claude-runs-${OLD}.json`]: success(OLD),
    [`compare-${OLD}.json`]: { files: [{ filename: "README.md" }] },
    ...overrides,
  });
  const decide = (overrides = {}, envOverrides = {}) => {
    const result = runStep(name, { env: { ...env, ...envOverrides }, payloads: payloads(overrides) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return { shouldReview: outputOf(result, "should_review"), calls: result.calls };
  };

  const verified = decide();
  assert.equal(verified.shouldReview, "false", "검증된 리뷰가 commit-set에 있으면 다시 리뷰하지 않는다");
  assert.match(verified.calls, new RegExp(`compare/${BASE}\\.\\.\\.${OLD}`), "workflow 변경은 base...리뷰 commit 범위로 본다");
  assert.equal(decide({}, { EVENT_ACTION: "reopened" }).shouldReview, "false");
  for (const [eventName, action] of [["pull_request", "opened"], ["pull_request", "ready_for_review"], ["workflow_dispatch", ""]]) {
    const result = decide({}, { EVENT_NAME: eventName, EVENT_ACTION: action });
    assert.equal(result.shouldReview, "true", `${eventName}/${action}은 항상 리뷰한다`);
    assert.equal(result.calls, "", `${eventName}/${action}은 이전 리뷰를 조회하지 않는다`);
  }

  assert.equal(decide({ "commits.json": [[{ sha: HEAD }]] }).shouldReview, "true", "rebase로 리뷰 commit이 PR에서 사라지면 다시 리뷰한다");
  assert.equal(decide({ [`claude-runs-${OLD}.json`]: { total_count: 0, workflow_runs: [] } }).shouldReview, "true", "검증 run success가 없음");
  assert.equal(
    decide({ [`claude-runs-${OLD}.json`]: { total_count: 1, workflow_runs: [{ head_sha: OLD, conclusion: "failure" }] } }).shouldReview,
    "true",
    "검증 run이 failure만 있음",
  );
  assert.equal(
    decide({ [`compare-${OLD}.json`]: { files: [{ filename: ".github/workflows/claude-code-review.yml" }] } }).shouldReview,
    "true",
    "리뷰 commit까지 claude-code-review.yml을 바꾼 PR의 run success는 믿지 않는다",
  );
  assert.equal(
    decide({ [`compare-${OLD}.json`]: { files: [{ filename: "x.yml", previous_filename: ".github/workflows/claude-code-review.yml" }] } }).shouldReview,
    "true",
    "workflow 파일 rename도 변경이다",
  );
  assert.equal(
    decide({ [`compare-${OLD}.json`]: { files: Array.from({ length: 300 }, () => ({ filename: "f" })) } }).shouldReview,
    "true",
    "변경 파일 목록이 잘릴 수 있으면 검증된 리뷰로 보지 않는다",
  );
  for (const [body, reason] of [["", "빈 본문 wrapper"], ["요약만 있고 개수 줄 없음", "개수 줄 없음"], ["요약\n🔴 0 · 🟡 0 · 🟣 0", "개수 줄이 첫 줄이 아님"]]) {
    const result = decide({ "reviews.json": [[claudeReview(1, { commit_id: OLD, body })]] });
    assert.equal(result.shouldReview, "true", reason);
    assert.doesNotMatch(result.calls, /actions\/workflows|compare/, `${reason}: 후보가 아니면 run·compare를 조회하지 않는다`);
  }
  for (const [overrides, reason] of [
    [{ user: { ...CLAUDE, id: 1 } }, "위조 신원"],
    [{ author_association: "OWNER" }, "NONE이 아닌 association"],
    [{ state: "APPROVED" }, "APPROVED"],
  ]) {
    assert.equal(decide({ "reviews.json": [[claudeReview(1, { commit_id: OLD, ...overrides })]] }).shouldReview, "true", reason);
  }
});

test("실행 전 Review id 목록과의 차집합으로 이번 실행의 claude[bot] Review 정확히 하나를 찾는다", () => {
  const names = stepNames("review");
  assert.equal(names.indexOf("Snapshot existing reviews") + 1, names.indexOf("Run Claude Code review"), "action 바로 앞에서 목록을 저장한다");
  assert.equal(names.indexOf("Run Claude Code review") + 1, names.indexOf("Verify Claude review object"));
  assert.match(stepBlock("Snapshot existing reviews"), /\n {8}id: before\n/);
  const snapshotted = runStep("Snapshot existing reviews", {
    env: { REPO: "o/r", PR_NUMBER: "7" },
    payloads: { "reviews.json": [[claudeReview(4), { id: 5, user: { login: "someone" } }], [claudeReview(9, { body: "" })]] },
  });
  assert.equal(snapshotted.status, 0, snapshotted.stderr);
  assert.equal(outputOf(snapshotted, "review_ids"), "[4,5,9]");

  const verify = stepBlock("Verify Claude review object");
  assert.match(verify, /BEFORE_REVIEW_IDS: \$\{\{ steps\.before\.outputs\.review_ids \}\}/);
  assert.match(verify, /HEAD_SHA: \$\{\{ needs\.target\.outputs\.head_sha \}\}/);
  // 시계(runner 시각·submitted_at 창)로 이번 실행의 Review를 고르지 않는다(D3).
  assert.doesNotMatch(verify, /submitted_at|since|date /);
  // 필터는 한 번만 계산하고 verdict·review는 그 결과에서 파생한다(F5).
  assert.equal(verify.match(/is_claude/g)?.length, 1);
  assert.match(verify, /review=\$\(jq -c '\.\[0\]' <<<"\$\{run_reviews\}"\)/);

  const verified = (reviews, inline = {}) => runStep("Verify Claude review object", {
    env: { REPO: "o/r", PR_NUMBER: "7", HEAD_SHA: HEAD, BEFORE_REVIEW_IDS: "[1]" },
    payloads: {
      "reviews.json": [reviews],
      ...Object.fromEntries(Object.entries(inline).map(([id, comments]) => [`inline-${id}.json`, [comments.map((body) => ({ body }))]])),
    },
  }).status;
  const old = claudeReview(1, { submitted_at: "2026-09-29T09:00:00Z" });

  assert.equal(verified([old, claudeReview(2)], { 2: ["🟡 Nit"] }), 0, "이번 실행의 단일 요약 Review");
  assert.equal(verified([old, claudeReview(3, { body: "" }), claudeReview(2)], { 2: ["🟡 Nit"] }), 0, "빈 본문 thread 답글 wrapper는 세지 않는다");
  assert.equal(verified([old]), 1, "실행 전부터 있던 Review만 있음(시각이 늦어도 세지 않는다)");
  assert.equal(verified([]), 1, "Review 없음");
  assert.equal(verified([old, claudeReview(2), claudeReview(3)], { 2: ["🟡 Nit"], 3: ["🟡 Nit"] }), 1, "Review 중복 게시");
  assert.equal(verified([old, claudeReview(2, { commit_id: OLD })], { 2: ["🟡 Nit"] }), 1, "다른 head");
  assert.equal(verified([old, claudeReview(2, { state: "APPROVED" })], { 2: ["🟡 Nit"] }), 1, "APPROVE 게시");
  assert.equal(verified([old, claudeReview(2, { user: { ...CLAUDE, id: 1 } })], { 2: ["🟡 Nit"] }), 1, "위조 신원");
  assert.equal(verified([old, claudeReview(2, { body: "요약만" })]), 1, "개수 줄 없는 Review만 게시");
});

test("🔴·🟡 finding은 같은 심각도의 inline thread로만 인정되고 모자라면 job을 실패시킨다", () => {
  // 병합 차단은 미해결 inline thread에 의존한다. 심각도별로 세지 않으면 🟣 inline이 빠진 🔴 자리를 채운다(F2).
  const verify = stepBlock("Verify Claude review object");
  assert.match(verify, /gh api --paginate --slurp "repos\/\$\{REPO\}\/pulls\/\$\{PR_NUMBER\}\/reviews\/\$\{review_id\}\/comments"/);
  assert.match(verify, /if \[ "\$\{coverage\}" != "true" \]; then[\s\S]*?exit 1/);
  const covered = (body, comments) => runStep("Verify Claude review object", {
    env: { REPO: "o/r", PR_NUMBER: "7", HEAD_SHA: HEAD, BEFORE_REVIEW_IDS: "[]" },
    payloads: {
      "reviews.json": [[claudeReview(2, { body })]],
      "inline-2.json": [comments.map((comment) => ({ body: comment }))],
    },
  }).status;

  assert.equal(covered("🔴 1 · 🟡 0 · 🟣 1\n요약", ["🟣 Pre-existing"]), 1, "🟣 inline이 본문에만 둔 🔴를 대신하지 못한다");
  assert.equal(covered("🔴 1 · 🟡 0 · 🟣 0\n요약", []), 1, "본문에만 둔 Important");
  assert.equal(covered("🔴 1 · 🟡 0 · 🟣 0\n요약", ["🔴 Important"]), 0, "Important 1건 inline");
  assert.equal(covered("🔴 1 · 🟡 1 · 🟣 0\n요약", ["🟡 Nit", "🟡 Nit"]), 1, "🟡 inline이 🔴 자리를 채우지 못한다");
  assert.equal(covered("🔴 1 · 🟡 1 · 🟣 0\n요약", ["🔴 Important", "🟡 Nit"]), 0, "심각도별 inline이 모두 있음");
  assert.equal(covered("🔴 0 · 🟡 2 · 🟣 1\n요약", ["🟡 Nit", "🟣 Pre-existing"]), 1, "Nit 1건 누락");
  assert.equal(covered("🔴 0 · 🟡 2 · 🟣 1\n요약", ["🟡 Nit", "🟡 Nit"]), 0, "Pre-existing은 본문 허용");
  assert.equal(covered("🔴 0 · 🟡 0 · 🟣 0\nfinding 없음", []), 0, "finding 없음");
});

test("문서 파편 규칙은 fragment resources 목록 기준이고 README·workflow를 직접 지목하지 않는다", () => {
  // fragment는 contracts/documentation resources만 추적한다. 파일군을 직접 나열하면 오탐 finding이 된다 (hub PR #3007 F1).
  const review = stepBlock("Run Claude Code review");
  assert.match(review, /contracts\/documentation\/documentation-fragment\.json의 resources에 등록된 파일/);
  assert.doesNotMatch(review, /SecurityConfig|README, workflow/);
});

test("#200 계약 테스트 두 파일은 Platform CI 계약 테스트 step에서 실행된다", () => {
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const run = ci.match(/- name: Test platform contracts\n {8}run: \|\n((?: {10}[^\n]*\n)+)/)?.[1];
  assert.ok(run, "Test platform contracts step의 run 블록이 필요하다");
  const commands = run.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const file of ["tools/ci/automerge-queue.test.mjs", "tools/ci/claude-code-review-workflow.test.mjs"]) {
    assert.ok(commands.includes(`node --test ${file}`), `${file}이 Platform CI 계약 테스트 step에 있어야 한다`);
  }
});
