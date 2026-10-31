import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  auditWorkflowJqInvocations,
  validateJqAsBindings,
} from './lib/automerge-queue-jq-ast.mjs';

const workflowUrl = new URL(
  '../../.github/workflows/automerge-queue.yml',
  import.meta.url,
);
const ciWorkflowUrl = new URL('../../.github/workflows/ci.yml', import.meta.url);
const workflowsDirUrl = new URL('../../.github/workflows/', import.meta.url);
const prTemplateUrls = [
  new URL('../../.github/PULL_REQUEST_TEMPLATE/full.md', import.meta.url),
  new URL('../../.github/PULL_REQUEST_TEMPLATE/short.md', import.meta.url),
  new URL('../../.github/pull_request_template.md', import.meta.url),
];

const COORDINATE_IF =
  "if: ${{ !cancelled() && (github.event_name != 'schedule' || needs.queue-probe.outputs.labeled == 'true') && (github.event_name != 'pull_request_target' || github.event.label.name == 'automerge') }}";

const readWorkflow = () => readFile(workflowUrl, 'utf8');
const MARKER_SYNC_RE =
  /# authorization-marker-sync-begin\n([\s\S]*?)\n\s+# authorization-marker-sync-end/;
const REVIEW_JQ_DEFS_RE =
  /^\s+review_jq_defs="\$\(cat <<'JQ'\n([\s\S]*?)\n\s+JQ\n\s+\)"$/m;

// `run: |` 블록의 본문은 10칸 들여쓰기다. 셸 블록을 그대로 실행하려면 벗겨야 한다.
// 큐 루프 안쪽 블록은 셸 들여쓰기 2칸이 더 붙어 12칸이다.
const dedent = (block, width = 10) =>
  block.replace(new RegExp(`^ {${width}}`, 'gm'), '');

const stubbedBash = (lines) => {
  const dir = mkdtempSync(join(tmpdir(), 'automerge-queue-'));
  const log = join(dir, 'gh.log');
  const result = spawnSync(
    'bash',
    ['-c', [`GH_LOG=${JSON.stringify(log)}`, ': > "$GH_LOG"', ...lines].join('\n')],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls: existsSync(log) ? readFileSync(log, 'utf8') : '',
  };
};

test('코디네이터는 기본 토큰이 github.token이고 AUTOMERGE_PAT는 병합 토큰으로만 참조한다', async () => {
  const workflow = await readWorkflow();

  for (const contract of [
    'GH_TOKEN: ${{ github.token }}',
    'pull_request_target:',
    'workflow_run:',
    'workflow_dispatch:',
    'pull_request_review:',
    'permissions: {}',
    'actions: write',
    'checks: read',
    'statuses: read',
    'contents: write',
    'pull-requests: write',
  ]) {
    assert.ok(workflow.includes(contract), `missing contract: ${contract}`);
  }

  // secrets 참조는 병합 토큰용 AUTOMERGE_PAT 하나뿐이다. 기본 GH_TOKEN은 github.token이다.
  assert.ok(
    [...workflow.matchAll(/secrets\.(\w+)/g)].every((match) => match[1] === 'AUTOMERGE_PAT'),
  );
  // PR branch 변경은 게이트를 통과한 BEHIND 후보의 PAT base 갱신 한 곳뿐이다(QA 결정 2026-09-29).
  const updateBranchCalls = workflow.split('\n').filter((line) => /\bgh api\b.*update-branch/.test(line));
  assert.equal(updateBranchCalls.length, 1, 'base update must be requested from exactly one place');
  assert.ok(
    updateBranchCalls[0].includes('GH_TOKEN="${MERGE_GH_TOKEN}" gh api --method PUT "repos/${repo}/pulls/${pr}/update-branch"'),
    'base update must be a PAT PUT on the candidate PR',
  );
  // 관리자 우회 병합과 squash 이외의 병합 방식은 사용하지 않는다. main ruleset의
  // allowed_merge_methods도 squash 하나뿐이다.
  assert.doesNotMatch(workflow, /--admin|gh pr merge.+--merge|gh pr merge.+--rebase/);
  // 이 저장소는 allow_auto_merge가 꺼져 있어 `--auto`가 API 오류로 실패한다. 형제 저장소
  // 상수를 옮기듯 이 플래그를 옮기면 큐가 병합 지점에서 매번 죽는다.
  assert.doesNotMatch(workflow, /gh pr merge[^\n]*--auto/);
  assert.ok(workflow.includes('gh pr merge --squash "${pr}" --repo "${repo}"'));
  // 라벨 트리거는 base 저장소 권한으로 도는 pull_request_target이어야 한다.
  assert.ok(workflow.includes("github.event_name != 'pull_request_target'"));
  assert.ok(!workflow.includes('  pull_request:\n'));
  // workflow_run 트리거는 이 저장소의 CI 워크플로 이름과 일치해야 한다.
  assert.ok(workflow.includes('workflows: [Platform CI]'));
});

test('병합 예약과 update-branch만 AUTOMERGE_PAT 병합 토큰을 쓰고 나머지는 github.token을 유지한다', async () => {
  const workflow = await readWorkflow();
  assert.ok(
    workflow.includes(
      "MERGE_GH_TOKEN: ${{ secrets.AUTOMERGE_PAT != '' && secrets.AUTOMERGE_PAT || github.token }}",
    ),
  );
  assert.ok(workflow.includes("HAS_AUTOMERGE_PAT: ${{ secrets.AUTOMERGE_PAT != '' }}"));
  assert.ok(workflow.includes('GH_TOKEN: ${{ github.token }}'));
  assert.match(workflow, /if \[ "\$\{HAS_AUTOMERGE_PAT\}" != "true" \]; then/);
  assert.match(workflow, /::warning::AUTOMERGE_PAT/);

  const prefix = 'GH_TOKEN="${MERGE_GH_TOKEN}" ';
  const lines = workflow.split('\n');
  const mergeLines = lines.filter((line) => /\bgh pr merge --squash\b/.test(line));
  const updateLines = lines.filter(
    (line) => /update-branch/.test(line) && /\bgh (api|pr)\b/.test(line),
  );
  assert.ok(mergeLines.length >= 1, 'merge call not found');
  for (const line of [...mergeLines, ...updateLines]) {
    assert.ok(
      line.includes(prefix + 'gh '),
      'merge/update-branch call must use MERGE_GH_TOKEN: ' + line.trim(),
    );
  }

  // 병합 토큰은 병합·update-branch 호출 외에는 어디에도 쓰지 않는다.
  const prefixed = lines.filter((line) => line.includes(prefix));
  assert.equal(prefixed.length, mergeLines.length + updateLines.length);

  const others = lines.filter(
    (l) => /gh api --method (POST|PATCH)/.test(l) || /--disable-auto/.test(l) || /gh workflow run/.test(l),
  );
  for (const line of others) {
    assert.ok(!line.includes('MERGE_GH_TOKEN'), 'must keep github.token: ' + line.trim());
  }
});

test('automerge label 이벤트만 exact-head frozen discovery marker를 발행한다', async () => {
  const workflow = await readWorkflow();

  for (const contract of [
    "EVENT_NAME: ${{ github.event_name }}",
    "EVENT_LABEL: ${{ github.event_name == 'pull_request_target' && github.event.label.name || '' }}",
    "EVENT_PR: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.number || '' }}",
    "EVENT_HEAD: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || '' }}",
    COORDINATE_IF,
    'pull_request_target:\n    types: [labeled]',
  ]) {
    assert.ok(workflow.includes(contract), `missing label authorization contract: ${contract}`);
  }

  const authorizationBlock = workflow.match(
    /          if \[\[ "\$\{EVENT_NAME\}" == "pull_request_target" && "\$\{EVENT_LABEL\}" == "automerge" \]\]; then\n([\s\S]*?)\n          fi\n\n          # required context/,
  )?.[0];
  assert.ok(authorizationBlock, 'label authorization block must stay testable');
  assert.equal(
    (authorizationBlock.match(/gh api --method POST/g) ?? []).length,
    1,
    'label authorization must have exactly one marker emission path',
  );

  // 라벨 이벤트는 기존 canonical marker를 읽어 PATCH-or-POST로 수렴한다. 픽스처는 comment 페이지다.
  const runAuthorization = ({ eventName, label = 'automerge', pr, head, pages = [[]] }) => {
    const dir = mkdtempSync(join(tmpdir(), 'automerge-authorization-'));
    const log = join(dir, 'gh.log');
    pages.forEach((page, index) =>
      writeFileSync(join(dir, `page-${index + 1}.json`), page === '__FAIL__' ? page : JSON.stringify(page)),
    );
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -euo pipefail',
          `GH_LOG=${JSON.stringify(log)}`,
          `FIX=${JSON.stringify(dir)}`,
          ': > "$GH_LOG"',
          'gh() {',
          '  printf "%s\\n" "gh $*" >> "$GH_LOG"',
          '  local all="$*"',
          '  case "$all" in',
          '    *"/comments?per_page=100&page="*) page="${all##*page=}"; [[ -f "$FIX/page-$page.json" ]] || { printf "[]\\n"; return 0; }; [[ "$(cat "$FIX/page-$page.json")" == __FAIL__ ]] && return 1; cat "$FIX/page-$page.json" ;;',
          '  esac',
          '}',
          'repo=o/r',
          `EVENT_NAME=${JSON.stringify(eventName)}`,
          `EVENT_LABEL=${JSON.stringify(label)}`,
          `EVENT_PR=${JSON.stringify(pr)}`,
          `EVENT_HEAD=${JSON.stringify(head)}`,
          dedent(authorizationBlock),
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    return {
      status: result.status,
      calls: existsSync(log) ? readFileSync(log, 'utf8') : '',
    };
  };

  const nonLabelEvent = runAuthorization({ eventName: 'workflow_run', pr: '', head: '' });
  assert.equal(nonLabelEvent.status, 0);
  assert.equal((nonLabelEvent.calls.match(/gh api --method POST/g) ?? []).length, 0);

  const otherLabel = runAuthorization({
    eventName: 'pull_request_target',
    label: 'documentation',
    pr: '42',
    head: 'a'.repeat(40),
  });
  assert.equal(otherLabel.status, 0);
  assert.equal((otherLabel.calls.match(/gh api --method POST/g) ?? []).length, 0);

  const valid = runAuthorization({
    eventName: 'pull_request_target',
    pr: '42',
    head: 'a'.repeat(40),
  });
  assert.equal(valid.status, 0);
  assert.equal((valid.calls.match(/gh api --method POST/g) ?? []).length, 1);
  assert.match(
    valid.calls,
    /repos\/o\/r\/issues\/42\/comments -f body=<!-- Automerge frozen discovery authorization: a{40} -->/,
  );

  for (const invalid of [
    { pr: 'not-a-number', head: 'a'.repeat(40) },
    { pr: '42', head: 'A'.repeat(40) },
    { pr: '42', head: 'a'.repeat(39) },
  ]) {
    const rejected = runAuthorization({ eventName: 'pull_request_target', ...invalid });
    assert.notEqual(rejected.status, 0);
    assert.equal((rejected.calls.match(/gh api --method POST/g) ?? []).length, 0);
  }

  // PATCH-or-POST 수렴: canonical marker는 PR당 1개로 유지한다(backend·mobile과 동일).
  const bot = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' };
  const markerOf = (sha) => `<!-- Automerge frozen discovery authorization: ${sha} -->`;
  const mutations = (calls) => calls.split('\n').filter((line) => /--method (PATCH|POST)/.test(line));
  const relabeled = runAuthorization({
    eventName: 'pull_request_target', pr: '42', head: 'a'.repeat(40),
    pages: [[{ id: 7, body: markerOf('b'.repeat(40)), user: bot }]],
  });
  assert.equal(relabeled.status, 0);
  assert.deepEqual(mutations(relabeled.calls), [
    `gh api --method PATCH repos/o/r/issues/comments/7 -f body=${markerOf('a'.repeat(40))}`,
  ], 'relabel must PATCH the single canonical marker instead of posting another');
  // 이미 여러 개 쌓인 PR은 라벨 재부착으로 정리한다: 가장 오래된 하나를 새 head로, 나머지는
  // canonical이 아닌 superseded 본문으로 바꾼다. 삭제하지 않는다.
  const accumulated = runAuthorization({
    eventName: 'pull_request_target', pr: '42', head: 'a'.repeat(40),
    pages: [[{ id: 9, body: markerOf('c'.repeat(40)), user: bot }, { id: 7, body: markerOf('b'.repeat(40)), user: bot }]],
  });
  assert.equal(accumulated.status, 0);
  assert.deepEqual(mutations(accumulated.calls), [
    `gh api --method PATCH repos/o/r/issues/comments/7 -f body=${markerOf('a'.repeat(40))}`,
    'gh api --method PATCH repos/o/r/issues/comments/9 -f body=<!-- Automerge frozen discovery authorization superseded -->',
  ]);
  assert.doesNotMatch(accumulated.calls, /--method DELETE/);
  const spoofed = runAuthorization({
    eventName: 'pull_request_target', pr: '42', head: 'a'.repeat(40),
    pages: [[{ id: 7, body: markerOf('b'.repeat(40)), user: { ...bot, id: 1 } }]],
  });
  assert.equal(spoofed.status, 0);
  assert.deepEqual(mutations(spoofed.calls), [
    `gh api --method POST repos/o/r/issues/42/comments -f body=${markerOf('a'.repeat(40))}`,
  ], 'a spoofed marker is not canonical');
  const full = (id) => Array.from({ length: 100 }, (_, index) => ({ id: id * 1000 + index, body: 'x', user: { login: 'someone', id: 5, type: 'User' } }));
  for (const [label, pages] of [
    ['comment read failure', ['__FAIL__']],
    ['malformed comment page', [{ message: 'Not Found' }]],
    ['comment history beyond the bounded read', [full(1), full(2), full(3), [{ id: 1, body: 'x', user: bot }]]],
  ]) {
    const failed = runAuthorization({ eventName: 'pull_request_target', pr: '42', head: 'a'.repeat(40), pages });
    assert.notEqual(failed.status, 0, `${label} must fail the label authorization`);
    assert.deepEqual(mutations(failed.calls), [], `${label} must not mutate markers`);
  }
  const bounded = runAuthorization({ eventName: 'pull_request_target', pr: '42', head: 'a'.repeat(40), pages: [full(1), full(2), full(3), []] });
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.equal(mutations(bounded.calls).length, 1);
});

test('큐는 best-effort FIFO 후보 배열을 훑고 미해결 thread는 fail closed다', async () => {
  const workflow = await readWorkflow();

  for (const contract of [
    '--base main --state open --label automerge',
    '--limit 1000',
    '.isDraft == false',
    // draft는 선택 단계에서 걸러야 한다. `gh pr list`는 draft를 필터하지 않으므로
    // 큐 맨 앞의 draft 하나가 매 실행을 실패시켜 큐 전체를 멈춘다.
    '--json number,createdAt,isDraft',
    // 후보는 단일 값이 아니라 오래된 순 배열이다. head 하나만 보는 구조가
    // head-of-line blocking의 원인이었다.
    '[.[] | select(.isDraft == false)] | [sort_by(.createdAt)[].number]',
    '# queue-loop-begin',
    '# candidate-budget-begin',
    '# candidate-offset-begin',
    '# candidate-window-begin',
    'reviewThreads(first: 100)',
    'hasNextPage',
    'pageInfo.hasNextPage == false',
    'all(.data.repository.pullRequest.reviewThreads.nodes[]; .isResolved)',
    '--match-head-commit "${head}"',
  ]) {
    assert.ok(workflow.includes(contract), `missing contract: ${contract}`);
  }

  // 단일 head 구조의 잔재가 남으면 배열을 뽑아도 첫 후보에서 실행이 끝난다.
  assert.doesNotMatch(workflow, /sort_by\(\.createdAt\)\[0\]\.number \/\/ empty/);
  assert.doesNotMatch(workflow, /\[\[ -n "\$\{pr\}" \]\] \|\| exit 0/);
});

test('required context는 ruleset 전수 조회로만 판정한다', async () => {
  const workflow = await readWorkflow();

  for (const contract of [
    '/rules/branches/main',
    'required_status_checks',
    'integration_id',
    "jq -e 'length > 0' <<<\"${required}\"",
  ]) {
    assert.ok(workflow.includes(contract), `missing contract: ${contract}`);
  }

  // 하드코딩 폴백은 ruleset 변경·조회 실패를 통과시킨다. 조회 실패는 fail closed여야 한다.
  assert.doesNotMatch(workflow, /required_checks='\[/);
  assert.doesNotMatch(workflow, /"Platform CI"\]/);
});

test('REST 목록 조회는 페이지 상한 안에서 읽고 넘치면 판정을 포기한다', async () => {
  const workflow = await readWorkflow();

  // `--paginate`는 페이지 수에 상한이 없어 이력이 긴 후보 하나가 예산 모델을 넘긴다.
  const codeLines = workflow.split('\n').filter((line) => !/^\s*#/.test(line));
  assert.ok(
    !codeLines.some((line) => line.includes('--paginate')),
    'unbounded --paginate must not come back',
  );
  for (const contract of [
    'page_limit=3',
    'read_pages() {',
    'read_pages "repos/${repo}/pulls/${pr}/reviews"',
    'read_pages "repos/${repo}/issues/${pr}/comments"',
    'read_pages "repos/${repo}/pulls/${pr}/commits"',
    'read_pages "repos/${repo}/pulls/${pr}/files"',
    'gh api "repos/${repo}/pulls/${pr}"',
    'gh api "repos/${repo}/actions/runs?head_sha=${head}&per_page=100"',
    'read_pages "repos/${repo}/commits/${head}/check-runs"',
    'read_pages "repos/${repo}/commits/${head}/statuses"',
  ]) {
    assert.ok(workflow.includes(contract), `missing contract: ${contract}`);
  }
  // `/status`는 조합 결과를 단일 객체로 주고 페이지네이션되지 않는다. `/statuses`여야 한다.
  assert.doesNotMatch(workflow, /\/commits\/\$\{head\}\/status"/);
  assert.ok(workflow.includes('($statuses | flatten) as $status_records'));

  // 헬퍼를 그대로 돌려 페이지 수집과 상한 동작을 실측한다.
  const readPages = workflow.match(
    /# paginated-read-begin\n([\s\S]*?)\n\s+# paginated-read-end/,
  )?.[1];
  assert.ok(readPages, 'paginated read helper must stay testable');

  const runReadPages = (pages, { shape = 'array' } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'read-pages-'));
    pages.forEach((page, index) => {
      writeFileSync(
        join(dir, `page-${index + 1}.json`),
        JSON.stringify(shape === 'array' ? page : { check_runs: page }),
      );
    });
    const result = stubbedBash([
      'set -euo pipefail',
      `DIR=${JSON.stringify(dir)}`,
      'gh() {',
      `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
      '  local all="$*"',
      '  local page="${all##*page=}"',
      '  cat "$DIR/page-${page}.json" 2>/dev/null || printf "[]"',
      '}',
      dedent(readPages),
      'if out="$(read_pages "repos/o/r/pulls/1/reviews")"; then',
      `  printf 'OK %s\\n' "$out"`,
      'else',
      `  printf 'STOPPED %s\\n' "$?"`,
      'fi',
    ]);
    return {
      status: result.status,
      stdout: result.stdout.trim(),
      requests: (result.calls.match(/gh api/g) ?? []).length,
    };
  };

  const full = (count) => Array.from({ length: count }, (_, index) => ({ id: index }));

  // 한 페이지로 끝나면 한 번만 부른다.
  const single = runReadPages([full(3)]);
  assert.equal(single.status, 0);
  assert.equal(single.requests, 1);
  assert.match(single.stdout, /^OK \[\[/);
  // 100건이 꽉 차면 다음 페이지를 읽고, 덜 찬 페이지에서 멈춘다.
  const twoPages = runReadPages([full(100), full(2)]);
  assert.equal(twoPages.requests, 2);
  assert.match(twoPages.stdout, /^OK /);
  // 상한을 넘기면 판정을 포기한다. 모르는 이력 위에서 병합하지 않는다(fail closed).
  const overflow = runReadPages([full(100), full(100), full(100), full(1)]);
  assert.equal(overflow.requests, 3, '페이지 상한을 넘겨 요청하면 예산 모델이 무너진다');
  assert.match(overflow.stdout, /^STOPPED 2/);
  // check-runs는 객체 모양이라 length 계산이 다르다. 같은 상한이 적용돼야 한다.
  const objectShape = runReadPages([full(100), full(100), full(100), full(1)], {
    shape: 'object',
  });
  assert.equal(objectShape.requests, 3);
  assert.match(objectShape.stdout, /^STOPPED 2/);
});

test('리뷰 게이트는 전 커밋의 활성 상태와 exact-head marker가 있는 frozen discovery를 함께 요구한다', async () => {
  const workflow = await readWorkflow();

  const reviewJqDefs = workflow.match(REVIEW_JQ_DEFS_RE)?.[1];
  assert.ok(reviewJqDefs, 'shared review_jq_defs must stay testable');
  const reviewBody = workflow.match(
    /# review-state-filter-begin\n[\s\S]*?if ! jq -s -e --arg head "\$\{head\}" "\$\{review_jq_defs\}"'\n([\s\S]*?)\n\s+' \\\n\s+<\(printf '%s\\n' "\$\{reviews\}"\) \\\n\s+<\(printf '%s\\n' "\$\{comments\}"\) \\\n\s+<\(printf '%s\\n' "\$\{commits\}"\) >\/dev\/null; then/,
  )?.[1];
  assert.ok(reviewBody, 'review state jq program must stay testable');
  const reviewProgram = `${reviewJqDefs}\n${reviewBody}`;

  const HEAD = 'a'.repeat(40);
  const PREVIOUS_HEAD = 'b'.repeat(40);
  const REMOVED_HEAD = 'e'.repeat(40);
  const DIFFERENT_HEAD = 'f'.repeat(40);
  const interrogateMarker = (sha = HEAD, actOn = 0) =>
    `<!-- pstack-interrogate head=${sha} act-on=${actOn} -->`;
  const interrogateBody = (sha = HEAD, actOn = 0) =>
    `## Summary\n\nNo blocking findings.\n\n${interrogateMarker(sha, actOn)}`;
  const aquilaFallbackBody =
    '**Actionable comments posted: 0**\n<!-- Review source: Aquila fallback; canonical visible structure: PR #1926 Review 4676157515 -->';
  const aquilaUniversalBody =
    '**Actionable comments posted: 0**\n<!-- Review source: Aquila Universal Review; engine: aquila-review -->';
  const codexFallbackBody =
    '**Actionable comments posted: 0**\n<!-- Review source: Codex CLI fallback; canonical visible structure: PR #1926 Review 4676157515 -->';
  const codeRabbit = {
    author_association: 'NONE',
    user: { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' },
  };
  const review = (id, state, submittedAt, body = '', overrides = {}) => ({
    id,
    state,
    submitted_at: submittedAt,
    commit_id: HEAD,
    author_association: 'OWNER',
    body,
    user: { login: 'reviewer', type: 'User' },
    ...overrides,
  });
  const marker = (sha = HEAD, overrides = {}) => ({
    body: `<!-- Automerge frozen discovery authorization: ${sha} -->`,
    user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
    ...overrides,
  });
  const runReviewFilter = (
    reviews,
    comments = [marker()],
    commits = [{ sha: PREVIOUS_HEAD }, { sha: HEAD }],
    headArg = HEAD,
  ) => {
    const directory = mkdtempSync(join(tmpdir(), 'automerge-review-filter-'));
    const reviewsPath = join(directory, 'reviews.json');
    const commentsPath = join(directory, 'comments.json');
    const commitsPath = join(directory, 'commits.json');
    writeFileSync(reviewsPath, JSON.stringify([reviews]));
    writeFileSync(commentsPath, JSON.stringify(comments));
    writeFileSync(commitsPath, JSON.stringify(commits));
    const result = spawnSync('jq', [
      '-s',
      '-e',
      '--arg', 'head', headArg,
      reviewProgram,
      reviewsPath,
      commentsPath,
      commitsPath,
    ], { encoding: 'utf8' });
    // jq -e는 결과가 false/null이면 1, 컴파일 오류면 3, 런타임 오류면 5를 낸다.
    // 0/1만 판정으로 인정해야 프로그램 파손이 "차단 성공"으로 새지 않는다.
    assert.ok(
      result.status === 0 || result.status === 1,
      `jq 하네스 파손 (status ${result.status}): ${result.stderr}`,
    );
    return result.status;
  };

  const exactMarker = [marker()];

  for (const comments of [
    [],
    [marker(DIFFERENT_HEAD)],
    [marker(HEAD), marker(HEAD)],
    [marker(PREVIOUS_HEAD), marker(HEAD)],
    [marker(HEAD, { user: { login: 'other[bot]', id: 41898282, type: 'Bot' } })],
    [marker(HEAD, { user: { login: 'github-actions[bot]', id: 1, type: 'Bot' } })],
    [marker(HEAD, { user: { login: 'github-actions[bot]', id: 41898282, type: 'User' } })],
  ]) {
    assert.notEqual(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody())], comments),
      0,
      'missing, duplicated, or spoofed authorization marker must block pstack-interrogate review',
    );
    assert.notEqual(
      runReviewFilter([
        review(1, 'COMMENTED', '2026-08-01T00:00:00Z', '', { ...codeRabbit, commit_id: PREVIOUS_HEAD }),
      ], comments),
      0,
      'missing, duplicated, or spoofed authorization marker must block prior CodeRabbit discovery',
    );
  }
  assert.equal(
    runReviewFilter(
      [review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody())],
      [
        marker(HEAD),
        {
          body: `<!-- Automerge frozen discovery authorization (superseded): ${PREVIOUS_HEAD} -->`,
          user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
        },
        {
          body: `<!-- Automerge base update requested: ${PREVIOUS_HEAD} -->`,
          user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
        },
      ],
    ),
    0,
    'single canonical marker alongside superseded and base-update comments must pass',
  );

  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z'),
    ], exactMarker),
    0,
  );
  assert.notEqual(
    runReviewFilter(
      [review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', { commit_id: REMOVED_HEAD })],
      exactMarker,
      [{ sha: HEAD }],
    ),
    0,
    'review on a commit removed by force-push must not pass',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', 'addressed?'),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', '', codeRabbit),
    ], exactMarker),
    0,
    'plain COMMENTED review from the same author must not clear a prior CHANGES_REQUESTED',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(PREVIOUS_HEAD, 0), {
        commit_id: PREVIOUS_HEAD,
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', '', codeRabbit),
    ], exactMarker),
    0,
    'prior-commit pstack-interrogate act-on=0 must not clear a prior CHANGES_REQUESTED',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(HEAD, 0)),
    ], exactMarker),
    0,
    'valid current-head pstack-interrogate act-on=0 from the same reviewer must clear CHANGES_REQUESTED',
  );
  assert.notEqual(
    runReviewFilter(
      [
        review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
        review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', { commit_id: PREVIOUS_HEAD }),
        review(3, 'COMMENTED', '2026-08-01T00:02:00Z', interrogateBody(HEAD, 0), {
          user: { login: 'reviewer-two', type: 'User' },
        }),
      ],
      exactMarker,
      [{ sha: PREVIOUS_HEAD }, { sha: HEAD }],
    ),
    0,
    'older-commit APPROVED must not clear newer-commit CHANGES_REQUESTED by same reviewer',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', 'pre-rebase cr', { commit_id: REMOVED_HEAD }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(DIFFERENT_HEAD, 0), {
        commit_id: DIFFERENT_HEAD,
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', interrogateBody(HEAD, 0), {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ], exactMarker),
    0,
    'pre-rebase pstack-interrogate act-on=0 must clear pre-rebase CHANGES_REQUESTED by same reviewer',
  );
  for (const [label, body] of [
    ['inline unclosed <!-- before act-on=0', `See \`<!--\` note.\n\n${interrogateMarker()}`],
    ['fenced unclosed <!-- before act-on=0', `\`\`\`sh\nm="<!-- "\n\`\`\`\n\n${interrogateMarker()}`],
    ['HTML comment holding triple backticks before act-on=0', `<!-- \`\`\` -->\n\n${interrogateMarker()}`],
    ['closed backslash span before decoy inline span', `\`\\\` and \`${interrogateMarker(PREVIOUS_HEAD, 2)}\`\n\n${interrogateMarker()}`],
  ]) {
    assert.equal(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', body)], exactMarker),
      0,
      label,
    );
  }

  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(
      runReviewFilter([
        review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(), {
          author_association: association,
        }),
      ]),
      0,
      `trusted ${association} pstack-interrogate review with act-on=0 on current head must pass`,
    );
  }
  assert.equal(
    runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateMarker())]),
    0,
    'exact single pstack-interrogate marker must pass',
  );
  assert.equal(
    runReviewFilter(
      [review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody())],
      [marker(), { body: 'x'.repeat(160 * 1024), user: { login: 'commenter' } }],
    ),
    0,
    'bounded large comment payload must not depend on the OS argument-size limit',
  );

  for (const invalidBody of [
    interrogateBody(HEAD, 1),
    interrogateBody(HEAD, 2),
    interrogateBody(HEAD, 10),
    `<!-- pstack-interrogate head=${HEAD} act-on=-1 -->`,
    `<!-- pstack-interrogate head=${HEAD} act-on=00 -->`,
    `<!-- pstack-interrogate head=${HEAD} act-on= -->`,
    `<!-- pstack-interrogate head=${HEAD} act-on=zero -->`,
    `<!-- pstack-interrogate head=${HEAD}  act-on=0 -->`,
    `<!-- pstack-interrogate head=${HEAD} act-on=0-->`,
    `<!-- pstack-interrogate act-on=0 head=${HEAD} -->`,
    `<!-- pstack-interrogate head=${HEAD} act-on=0 extra=1 -->`,
    `<!-- pstack-interrogate head=${HEAD.toUpperCase()} act-on=0 -->`,
    `${interrogateMarker(HEAD, 0)}\n${interrogateMarker(HEAD, 0)}`,
    `${interrogateMarker(HEAD, 1)}\n${interrogateMarker(HEAD, 0)}`,
    `${interrogateMarker(PREVIOUS_HEAD, 0)}\n${interrogateMarker(HEAD, 0)}`,
  ]) {
    assert.notEqual(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', invalidBody)]),
      0,
      `act-on>0, duplicate, or variant marker must fail closed: ${JSON.stringify(invalidBody)}`,
    );
  }

  for (const invalidHead of ['head', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), '']) {
    assert.notEqual(
      runReviewFilter(
        [review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(invalidHead, 0), { commit_id: invalidHead })],
        [marker(invalidHead)],
        [{ sha: invalidHead }],
        invalidHead,
      ),
      0,
      `non-40-lowercase-hex head must fail closed: ${JSON.stringify(invalidHead)}`,
    );
  }

  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(PREVIOUS_HEAD, 0), {
        commit_id: HEAD,
      }),
    ], exactMarker),
    0,
    'marker head differing from commit_id must fail closed',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(HEAD, 0), {
        commit_id: PREVIOUS_HEAD,
      }),
    ], exactMarker),
    0,
    'commit_id differing from current head and marker must fail closed',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(PREVIOUS_HEAD, 0), {
        commit_id: PREVIOUS_HEAD,
      }),
    ], exactMarker),
    0,
    'pstack-interrogate review on an earlier commit must not be reused for current head',
  );

  for (const retiredBody of [aquilaUniversalBody, aquilaFallbackBody, codexFallbackBody]) {
    assert.notEqual(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', retiredBody)]),
      0,
      `retired review marker must be rejected: ${retiredBody}`,
    );
  }

  for (const plainBody of ['', 'Looks good to me', null]) {
    assert.notEqual(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', plainBody)]),
      0,
      `plain COMMENTED review without marker must fail closed: ${JSON.stringify(plainBody)}`,
    );
  }

  for (const untrustedAssociation of [
    'NONE',
    'CONTRIBUTOR',
    'FIRST_TIMER',
    'FIRST_TIME_CONTRIBUTOR',
    'MANNEQUIN',
  ]) {
    assert.notEqual(
      runReviewFilter([
        review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(), {
          author_association: untrustedAssociation,
        }),
      ]),
      0,
      `untrusted ${untrustedAssociation} author must not pass even with a valid marker`,
    );
  }

  assert.equal(
    runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', '', codeRabbit)]),
    0,
    'CodeRabbit immutable Bot identity must pass on COMMENTED',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(), {
        ...codeRabbit,
        user: { ...codeRabbit.user, type: 'User' },
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', '', {
        author_association: 'NONE',
        user: null,
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(), {
        ...codeRabbit,
        user: { ...codeRabbit.user, login: 'other-bot[bot]' },
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(), {
        ...codeRabbit,
        user: { ...codeRabbit.user, id: 1 },
      }),
    ]),
    0,
  );

  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(), {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
  );
  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z'),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        commit_id: 'e'.repeat(40),
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', interrogateBody(), {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
    'out-of-PR APPROVED must not clear in-PR CHANGES_REQUESTED',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        commit_id: 'e'.repeat(40),
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        commit_id: 'f'.repeat(40),
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', interrogateBody(), {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
    'pre-rebase CHANGES_REQUESTED already cleared by pre-rebase APPROVED must not wedge after rebase',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody('e'.repeat(40), 2), {
        commit_id: 'e'.repeat(40),
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody('f'.repeat(40), 0), {
        commit_id: 'f'.repeat(40),
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', '', codeRabbit),
    ]),
    0,
    'pre-rebase ACT_ON already cleared by pre-rebase act-on=0 must not wedge CodeRabbit after rebase',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
      }),
    ], exactMarker),
    0,
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(PREVIOUS_HEAD, 0), {
        commit_id: PREVIOUS_HEAD,
      }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(HEAD, 0), {
        commit_id: HEAD,
      }),
    ], exactMarker),
    0,
    'fresh pstack-interrogate review on current head must pass after an earlier head review',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', '', {
        ...codeRabbit,
        commit_id: PREVIOUS_HEAD,
      }),
    ], exactMarker),
    0,
    'CodeRabbit discovery on an earlier PR commit must remain valid with exact-head authorization marker',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', codeRabbit),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z'),
    ]),
    0,
  );

  assert.equal(
    runReviewFilter([
      review(1, 'DISMISSED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
  );
  // 이 저장소 main ruleset은 dismiss_stale_reviews_on_push: true다.
  assert.equal(
    runReviewFilter([
      review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'DISMISSED', '2026-08-01T00:01:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'DISMISSED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'CHANGES_REQUESTED', '2026-08-01T00:01:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-two', type: 'User' },
      }),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-three', type: 'User' },
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'DISMISSED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'CHANGES_REQUESTED', '2026-08-01T00:01:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'DISMISSED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
      }),
    ]),
    0,
  );

  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(), {
        user: { login: 'pr-author', type: 'User' },
      }),
    ]),
    0,
  );

  for (const quotedExampleBody of [
    `Quoted fence:\n\`\`\`html\n${interrogateMarker(HEAD, 2)}\n\`\`\`\n\n${interrogateMarker(HEAD, 0)}`,
    `Quoted tilde:\n~~~\n${interrogateMarker(HEAD, 2)}\n~~~\n\n${interrogateMarker(HEAD, 0)}`,
    `Four backticks:\n\`\`\`\`md\n\`\`\`\n${interrogateMarker(HEAD, 2)}\n\`\`\`\n\`\`\`\`\n\n${interrogateMarker(HEAD, 0)}`,
    `CRLF fence:\r\n\`\`\`\r\n${interrogateMarker(HEAD, 2)}\r\n\`\`\`\r\n\r\n${interrogateMarker(HEAD, 0)}`,
    `Inline single: \`${interrogateMarker(HEAD, 2)}\`\n\n${interrogateMarker(HEAD, 0)}`,
    `Inline double: \`\` \`${interrogateMarker(HEAD, 2)}\` \`\`\n\n${interrogateMarker(HEAD, 0)}`,
    `- list item\n    \`\`\`html\n    ${interrogateMarker(HEAD, 2)}\n    \`\`\`\n\n${interrogateMarker(HEAD, 0)}`,
    `Indented 4-space:\n\n    ${interrogateMarker(HEAD, 2)}\n\n${interrogateMarker(HEAD, 0)}`,
    `Indented tab:\n\n\t${interrogateMarker(HEAD, 2)}\n\n${interrogateMarker(HEAD, 0)}`,
    `> ${interrogateMarker(HEAD, 2)}\n\n${interrogateMarker(HEAD, 0)}`,
    `   > \`\`\`\n   > ${interrogateMarker(HEAD, 2)}\n   > \`\`\`\n\n${interrogateMarker(HEAD, 0)}`,
    `Paragraph one \`stray\n\nParagraph two \`stray\n\n${interrogateMarker(HEAD, 0)}`,
    `<!-- note \`\`\` -->\nbody\n${interrogateMarker(HEAD, 0)}`,
    `\\\` text \`${interrogateMarker(HEAD, 1)}\`\n${interrogateMarker(HEAD, 0)}`,
    `    \`\`\`\n\n${interrogateMarker(HEAD, 0)}`,
    `### Example\n    ${interrogateMarker(HEAD, 2)}\n${interrogateMarker(HEAD, 0)}`,
    `\`\`\`md\n    \`\`\`\n${interrogateMarker(HEAD, 2)}\n\`\`\`\n${interrogateMarker(HEAD, 0)}`,
    `- > ${interrogateMarker(HEAD, 2)}\n${interrogateMarker(HEAD, 0)}`,
  ]) {
    assert.equal(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', quotedExampleBody)]),
      0,
      `marker examples inside CommonMark code/blockquote blocks must be ignored: ${JSON.stringify(quotedExampleBody)}`,
    );
  }

  for (const codeOrQuoteOnlyBody of [
    `\`\`\`\n${interrogateMarker(HEAD, 0)}\n\`\`\``,
    `~~~\n${interrogateMarker(HEAD, 0)}\n~~~`,
    `- list item\n    \`\`\`\n    ${interrogateMarker(HEAD, 0)}\n    \`\`\``,
    `\`${interrogateMarker(HEAD, 0)}\``,
    `\`\` \`${interrogateMarker(HEAD, 0)}\` \`\``,
    `    ${interrogateMarker(HEAD, 0)}`,
    `\t${interrogateMarker(HEAD, 0)}`,
    `Example:\n\n    ${interrogateMarker(HEAD, 0)}`,
    `> ${interrogateMarker(HEAD, 0)}`,
    `   > ${interrogateMarker(HEAD, 0)}`,
  ]) {
    assert.notEqual(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', codeOrQuoteOnlyBody)]),
      0,
      `marker present only inside code or blockquote must not satisfy discovery: ${JSON.stringify(codeOrQuoteOnlyBody)}`,
    );
  }

  for (const adversarialBlockingBody of [
    `\`\`\`\n${interrogateMarker(HEAD, 0)}`,
    `${interrogateMarker(HEAD, 0)}\n\nUnclosed trailing fence:\n\`\`\`\n${interrogateMarker(HEAD, 2)}`,
    `\`\`\`html\nunclosed fence before marker\n\n${interrogateMarker(HEAD, 1)}`,
    `- list item\n    \`\`\`\n    ${interrogateMarker(HEAD, 0)}\n    \`\`\`\n\n${interrogateMarker(HEAD, 1)}`,
    `Inline \`\`\n\`\`\`\n\`\` fence inversion\n\n${interrogateMarker(HEAD, 1)}\n\n\`\`\`\ndecoy\n\`\`\``,
    `Paragraph one \`stray\n\n${interrogateMarker(HEAD, 1)}\n\nParagraph three \`stray`,
    `prefix ${interrogateMarker(HEAD, 0)}`,
    ` ${interrogateMarker(HEAD, 0)}`,
    `   ${interrogateMarker(HEAD, 0)}`,
    `${interrogateMarker(HEAD, 0)} trailing`,
    `<!-- pstack-interrogate head=${HEAD} act-on=1`,
    `<!-- pstack-interrogate head=${HEAD} act-on=1\n${interrogateMarker(HEAD, 0)}`,
    `${interrogateMarker(HEAD, 0)}\n<!-- pstack-interrogate head=${HEAD} act-on=1`,
    `Note \\\`${interrogateMarker(HEAD, 2)}\\\`\n${interrogateMarker(HEAD, 0)}`,
  ]) {
    assert.notEqual(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', adversarialBlockingBody)]),
      0,
      `adversarial marker body must fail closed on its own: ${JSON.stringify(adversarialBlockingBody)}`,
    );
    assert.notEqual(
      runReviewFilter([
        review(1, 'COMMENTED', '2026-08-01T00:00:00Z', adversarialBlockingBody),
        review(2, 'COMMENTED', '2026-08-01T00:01:00Z', '', codeRabbit),
      ]),
      0,
      `adversarial marker body must set blocking state alongside CodeRabbit: ${JSON.stringify(adversarialBlockingBody)}`,
    );
  }

  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', '', codeRabbit),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(HEAD, 1), {
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
    'active ACT_ON_CURRENT review must block even when CodeRabbit and another reviewer approved',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(PREVIOUS_HEAD, 1), {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', '', codeRabbit),
    ]),
    0,
    'prior-commit act-on>0 must block CodeRabbit alone when no current-head human pass exists',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(PREVIOUS_HEAD, 1), {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(HEAD, 0), {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
    'current-head act-on=0 from another trusted human must supersede ACT_ON_PRIOR on CLEAN',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(PREVIOUS_HEAD, 1), {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
    'current-head APPROVED from another trusted human must supersede ACT_ON_PRIOR on CLEAN',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(PREVIOUS_HEAD, 1), {
        commit_id: PREVIOUS_HEAD,
      }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(PREVIOUS_HEAD, 0), {
        commit_id: PREVIOUS_HEAD,
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', '', codeRabbit),
    ]),
    0,
    'same reviewer prior-commit act-on=0 must clear that reviewer ACT_ON_PRIOR alongside CodeRabbit',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(HEAD, 1)),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', 'follow-up comment'),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', '', codeRabbit),
    ]),
    0,
    'plain COMMENTED review must not clear a prior ACT_ON_CURRENT state',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(HEAD, 1)),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(PREVIOUS_HEAD, 0), {
        commit_id: PREVIOUS_HEAD,
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', '', codeRabbit),
    ]),
    0,
    'prior-commit act-on=0 must not clear ACT_ON_CURRENT',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        commit_id: REMOVED_HEAD,
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', '', codeRabbit),
    ]),
    0,
    'out-of-PR APPROVED on a force-pushed-out commit must not clear CHANGES_REQUESTED',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(HEAD, 1)),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        commit_id: PREVIOUS_HEAD,
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', '', codeRabbit),
    ]),
    0,
    'prior-commit APPROVED must not clear ACT_ON_CURRENT',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        commit_id: PREVIOUS_HEAD,
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', '', codeRabbit),
    ]),
    0,
    'in-PR prior APPROVED must clear same reviewer CHANGES_REQUESTED alongside CodeRabbit',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(HEAD, 1)),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(HEAD, 0)),
    ]),
    0,
    'valid current-head act-on=0 from the same reviewer must clear ACT_ON_CURRENT',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
      review(2, 'DISMISSED', '2026-08-01T00:01:00Z'),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', '', codeRabbit),
    ]),
    0,
    'DISMISSED must clear a prior CHANGES_REQUESTED state from the same reviewer',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'APPROVED', '2026-08-01T00:00:00Z'),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(HEAD, 0)),
    ]),
    0,
    'valid current-head act-on=0 after APPROVED must satisfy human gate discovery',
  );

  for (const dismissedDiscovery of [
    [
      review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', {
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'DISMISSED', '2026-08-01T00:01:00Z', '', {
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', 'plain note', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ],
    [
      review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', {
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'DISMISSED', '2026-08-01T00:01:00Z', '', {
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', 'plain note', {
        user: { login: 'reviewer-one', type: 'User' },
      }),
    ],
    [
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'DISMISSED', '2026-08-01T00:01:00Z', '', {
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', 'plain note', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ],
  ]) {
    assert.notEqual(
      runReviewFilter(dismissedDiscovery),
      0,
      'dismissed APPROVED/CHANGES_REQUESTED review must not pass via a plain COMMENTED note',
    );
  }

  for (const invalidUserOverrides of [
    { user: null },
    { user: {} },
    { user: { login: 'reviewer' } },
    { user: { login: '', type: 'User' } },
    { user: { login: 123, type: 'User' } },
    { author_association: 'COLLABORATOR', user: { login: 'helper[bot]', type: 'Bot' } },
  ]) {
    assert.notEqual(
      runReviewFilter([review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', invalidUserOverrides)]),
      0,
      `malformed or bot human identity must not pass APPROVED: ${JSON.stringify(invalidUserOverrides)}`,
    );
    assert.notEqual(
      runReviewFilter([
        review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(HEAD, 0), invalidUserOverrides),
      ]),
      0,
      `malformed or bot human identity must not pass pstack-interrogate: ${JSON.stringify(invalidUserOverrides)}`,
    );
  }
});

test('required context 판정은 대기와 실패를 구분하고 뒤 페이지 status까지 본다', async () => {
  const workflow = await readWorkflow();

  const checkProgram = workflow.match(
    /# required-context-filter-begin\n\s+context_state="\$\(jq -r [^']+'\n([\s\S]*?)\n\s+' <<<"\$\{checks\}"\)"/,
  )?.[1];
  assert.ok(checkProgram, 'required context jq program must stay testable');

  // statusPages는 `gh api --paginate --slurp` 결과와 같은 페이지 배열이다.
  const classify = (
    checkRuns,
    statusPages = [],
    requiredCheck = { context: 'Platform CI', integration_id: null },
  ) => {
    const result = spawnSync(
      'jq',
      [
        '-r',
        '--argjson', 'required_check', JSON.stringify(requiredCheck),
        '--argjson', 'statuses', JSON.stringify(statusPages),
        checkProgram,
      ],
      { input: JSON.stringify([{ check_runs: checkRuns }]), encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `jq 하네스 파손: ${result.stderr}`);
    return result.stdout.trim();
  };

  const run = (overrides) => ({
    id: 1,
    name: 'Platform CI',
    conclusion: 'success',
    started_at: '2026-08-01T00:00:00Z',
    ...overrides,
  });

  // 최신 check run이 판정을 결정한다.
  assert.equal(
    classify([
      run({ id: 1, conclusion: 'success', started_at: '2026-08-01T00:00:00Z' }),
      run({ id: 2, conclusion: 'failure', started_at: '2026-08-01T00:01:00Z' }),
    ]),
    'failure',
  );
  assert.equal(
    classify([
      run({ id: 1, conclusion: 'failure', started_at: '2026-08-01T00:00:00Z' }),
      run({ id: 2, conclusion: 'success', started_at: '2026-08-01T00:01:00Z' }),
    ]),
    'success',
  );
  // 진행 중(conclusion null)은 계약 위반이 아니라 대기다. 이것을 failure로 처리하면
  // 그 실패 check가 PR을 UNSTABLE로 만들어 다음 실행을 같은 자리에서 죽인다.
  assert.equal(classify([run({ conclusion: null })]), 'pending');
  // 새 head에 아직 안 붙은 상태도 대기다. 병합은 여전히 success에서만 진행된다.
  assert.equal(classify([], []), 'missing');
  // required context가 두 번째 status 페이지에 있어도 찾아낸다.
  assert.equal(
    classify(
      [],
      [
        [{ id: 1, context: 'Other CI', state: 'success', updated_at: '2026-08-01T00:00:00Z' }],
        [{ id: 2, context: 'Platform CI', state: 'success', updated_at: '2026-08-01T00:01:00Z' }],
      ],
    ),
    'success',
  );
  // 뒤 페이지의 최신 실패가 앞 페이지의 성공을 덮는다.
  assert.equal(
    classify(
      [],
      [
        [{ id: 1, context: 'Platform CI', state: 'success', updated_at: '2026-08-01T00:00:00Z' }],
        [{ id: 2, context: 'Platform CI', state: 'failure', updated_at: '2026-08-01T00:01:00Z' }],
      ],
    ),
    'failure',
  );
  assert.equal(
    classify([], [[{ id: 1, context: 'Platform CI', state: 'pending', updated_at: '2026-08-01T00:00:00Z' }]]),
    'pending',
  );
  // check run이 있으면 그것이 정본이다. 실패한 check run을 동명 classic status로
  // 되살리지 않는다.
  assert.equal(
    classify(
      [run({ conclusion: 'failure' })],
      [[{ id: 2, context: 'Platform CI', state: 'success', updated_at: '2026-08-01T00:01:00Z' }]],
    ),
    'failure',
  );
  // 같은 이름의 check run과 classic status가 함께 있으면 둘 다 본다. 하나만 보면 나머지
  // 하나가 실패·대기여도 병합이 진행된다.
  assert.equal(
    classify(
      [run({ conclusion: 'success' })],
      [[{ id: 2, context: 'Platform CI', state: 'failure', updated_at: '2026-08-01T00:01:00Z' }]],
    ),
    'failure',
  );
  assert.equal(
    classify(
      [run({ conclusion: 'success' })],
      [[{ id: 2, context: 'Platform CI', state: 'pending', updated_at: '2026-08-01T00:01:00Z' }]],
    ),
    'pending',
  );
  assert.equal(
    classify(
      [run({ conclusion: 'success' })],
      [[{ id: 2, context: 'Platform CI', state: 'success', updated_at: '2026-08-01T00:01:00Z' }]],
    ),
    'success',
  );
  assert.equal(
    classify(
      [run({ conclusion: null })],
      [[{ id: 2, context: 'Platform CI', state: 'failure', updated_at: '2026-08-01T00:01:00Z' }]],
    ),
    'failure',
  );

  // integration_id가 지정된 required context는 다른 앱의 동명 check나 classic status로
  // 충족되지 않는다.
  assert.equal(
    classify(
      [run({ app: { id: 7 } })],
      [[{ id: 2, context: 'Platform CI', state: 'success', updated_at: '2026-08-01T00:01:00Z' }]],
      { context: 'Platform CI', integration_id: 42 },
    ),
    'missing',
  );
  assert.equal(
    classify([run({ app: { id: 42 } })], [], { context: 'Platform CI', integration_id: 42 }),
    'success',
  );
});

test('required context 판정은 후보별 건너뛰기로 수렴하고 실패는 신호를 남긴다', async () => {
  const workflow = await readWorkflow();

  // 분류 결과를 실제로 어떻게 처리하는지까지 고정한다. 대기든 실패든 이 후보만
  // 건너뛰고 다음 후보를 계속 평가한다. 실행을 끝내면 그 한 건이 뒤를 굶긴다.
  assert.doesNotMatch(workflow, /pending \| missing\)\n\s+echo[^\n]*\n\s+exit 0/);
  assert.doesNotMatch(workflow, /required context failed[\s\S]{0,40}exit 1/);
  // 실패는 조용히 묻히면 안 된다. 계약 위반은 annotation으로 run 요약에 남긴다.
  assert.match(workflow, /::warning::[^\n]*required context/);

  // 후보별 게이트 루프를 실제로 돌려 분류별 처리를 실측한다.
  const contextLoop = workflow.match(
    /# required-context-loop-begin\n([\s\S]*?)\n\s+# required-context-loop-end/,
  )?.[1];
  assert.ok(contextLoop, 'required context loop must stay testable');

  const runContextLoop = (checkRuns, mergeState = 'CLEAN') => {
    const result = stubbedBash([
      'set -euo pipefail',
      'gh() {',
      `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
      '}',
      'pr=39',
      'repo=o/r',
      'head_repo=o/r',
      'head_ref=feature',
      `merge_state=${JSON.stringify(mergeState)}`,
      `checks=${JSON.stringify(JSON.stringify([{ check_runs: checkRuns }]))}`,
      `statuses=${JSON.stringify(JSON.stringify([[]]))}`,
      `required=${JSON.stringify(JSON.stringify([{ context: 'Platform CI', integration_id: null }]))}`,
      // `continue`가 후보 루프를 넘기는 동작이므로 1회 루프로 감싸고, 루프를 끝까지
      // 진행한 경우에만 병합 분기 도달을 관측한다.
      'for _ in 1; do',
      dedent(contextLoop, 12),
      `  printf 'REACHED_DISPATCH\\n'`,
      'done',
    ]);
    return {
      status: result.status,
      reached: result.stdout.includes('REACHED_DISPATCH'),
      warned: (result.stdout + result.stderr).includes('::warning::'),
      dispatchedCi: result.calls.includes('workflow run ci.yml'),
      stdout: result.stdout,
    };
  };

  const run = (conclusion) => [
    { id: 1, name: 'Platform CI', conclusion, started_at: '2026-08-01T00:00:00Z' },
  ];

  // 전 context가 success여야 병합 분기에 닿는다.
  assert.deepEqual(runContextLoop(run('success')), {
    status: 0,
    reached: true,
    warned: false,
    dispatchedCi: false,
    stdout: 'REACHED_DISPATCH\n',
  });
  // 진행 중(pending)은 이미 붙은 check가 끝나기를 기다리는 상태다. 조용히 건너뛰고
  // CI를 새로 쏘지 않는다.
  const pending = runContextLoop(run(null));
  assert.equal(pending.status, 0);
  assert.equal(pending.reached, false, '대기 상태는 병합 분기에 닿으면 안 된다');
  assert.equal(pending.warned, false, '대기 상태는 사람이 볼 신호가 아니다');
  assert.equal(pending.dispatchedCi, false, '대기 중인 check에 CI를 또 쏘지 않는다');

  // 미부착(missing)은 다르다. same-repository head에는 CI를 명시 dispatch해 required
  // context를 붙인다. BEHIND·DIRTY는 이 블록보다 앞선 preflight에서 라벨이 제거된다.
  const missing = runContextLoop([]);
  assert.equal(missing.status, 0);
  assert.equal(missing.reached, false);
  assert.equal(missing.dispatchedCi, true, 'required context 부재는 CI dispatch로 푼다');

  // 추출한 context 블록만 실행해도 BEHIND 특례가 없음을 고정한다. 실제 workflow에서는
  // structural preflight가 먼저 실행되어 이 상태가 여기까지 내려오지 않는다.
  const missingBehind = runContextLoop([], 'BEHIND');
  assert.equal(missingBehind.status, 0);
  assert.equal(missingBehind.dispatchedCi, true);
  assert.equal(missingBehind.reached, false);
  // 부재가 아닌 사유(대기·실패)는 BEHIND라도 내려보내지 않는다. 대기는 곧 끝나고,
  // 실패는 사람이 고칠 상태다.
  assert.equal(runContextLoop(run(null), 'BEHIND').reached, false);
  assert.equal(runContextLoop(run('failure'), 'BEHIND').reached, false);
  // 명시적 실패도 실행을 죽이지 않고 이 후보만 건너뛰되, 신호는 남긴다.
  const failed = runContextLoop(run('failure'));
  assert.equal(failed.status, 0);
  assert.equal(failed.reached, false);
  assert.equal(failed.warned, true, 'required context 실패는 ::warning::으로 드러나야 한다');
});

test('BEHIND·DIRTY는 branch를 바꾸지 않고 PR-visible handoff로 큐에서 제거한다', async () => {
  const workflow = await readWorkflow();
  const preflight = workflow.match(
    /# merge-state-preflight-begin\n([\s\S]*?)\n\s+# merge-state-preflight-end/,
  )?.[1];
  assert.ok(preflight, 'merge state preflight must stay testable');
  const ownerHandoff = workflow.match(/# owner-handoff-begin\n([\s\S]*?)\n\s+# owner-handoff-end/)?.[1];
  assert.ok(ownerHandoff, 'owner handoff must stay testable');

  const markerPrefix = '<!-- easysubway-automerge-rebase-required:';
  const runPreflight = (
    mergeState,
    {
      existingHead,
      headReads = ['current-head', 'current-head'],
      headReadFails = [],
      commentReadFails = false,
      commentFails = false,
      labelFails = false,
      restoreFails = false,
      hasPat = false,
    } = {},
  ) => {
    const head = 'current-head';
    const marker = `${markerPrefix}${head} -->`;
    const comments = existingHead ? [[], [{ body: `${markerPrefix}${existingHead} -->` }]] : [[]];
    const result = stubbedBash([
      'set -euo pipefail',
      `read_pages() { ${commentReadFails ? 'return 2' : `printf '%s' ${JSON.stringify(JSON.stringify(comments))}`}; }`,
      'gh() {',
      `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
      '  case "$*" in',
      '    "pr view"*)',
      '      head_read="$(grep -c \'^gh pr view \' "$GH_LOG")"',
      `      case " ${headReadFails.join(' ')} " in *" ${'${head_read}'} "*) return 43 ;; esac`,
      `      printf '%s\\n' "${'${head_reads[$((head_read - 1))]:-${head}}'}" ;;`,
      `    "pr comment"*) ${commentFails ? 'return 41' : ':'} ;;`,
      `    "pr edit"*"--remove-label automerge"*) ${labelFails ? 'return 42' : ':'} ;;`,
      `    "pr edit"*"--add-label automerge"*) ${restoreFails ? 'return 44' : ':'} ;;`,
      '    *) return 1 ;;',
      '  esac',
      '}',
      'pr=26',
      'repo=o/r',
      `head=${JSON.stringify(head)}`,
      `head_reads=(${headReads.map((value) => JSON.stringify(value)).join(' ')})`,
      'GITHUB_SERVER_URL=https://github.com',
      'GITHUB_REPOSITORY=o/r',
      'MERGE_GH_TOKEN=merge-token',
      'GITHUB_RUN_ID=1234',
      `HAS_AUTOMERGE_PAT=${hasPat}`,
      `merge_state=${JSON.stringify(mergeState)}`,
      dedent(ownerHandoff),
      'for _ in 1; do',
      dedent(preflight, 12),
      `  printf 'PASSED_PREFLIGHT\\n' >> "$GH_LOG"`,
      'done',
      `printf 'SKIPPED\\n' >> "$GH_LOG"`,
    ]);
    return {
      status: result.status,
      commented: result.calls.includes('gh pr comment'),
      labelRemoved: result.calls.includes('--remove-label automerge'),
      labelRestored: result.calls.includes('--add-label automerge'),
      updatedBranch: result.calls.includes('update-branch'),
      skipped: result.calls.includes('SKIPPED'),
      passed: result.calls.includes('PASSED_PREFLIGHT'),
      calls: result.calls,
    };
  };

  // AUTOMERGE_PAT가 있으면 BEHIND는 handoff하지 않고 게이트로 내려가 base 갱신 후보가 된다.
  // DIRTY는 PAT와 무관하게 소유 세션에 돌려보낸다.
  const behindWithPat = runPreflight('BEHIND', { hasPat: true });
  assert.equal(behindWithPat.status, 0);
  assert.equal(behindWithPat.passed, true, 'BEHIND with the PAT must continue to the gates');
  assert.equal(behindWithPat.labelRemoved, false);
  assert.equal(behindWithPat.commented, false);
  assert.equal(behindWithPat.updatedBranch, false, 'preflight itself must not update the branch');
  const dirtyWithPat = runPreflight('DIRTY', { hasPat: true });
  assert.equal(dirtyWithPat.passed, false);
  assert.equal(dirtyWithPat.labelRemoved, true, 'DIRTY must keep the owner handoff even with the PAT');
  assert.equal(dirtyWithPat.commented, true);

  for (const mergeState of ['BEHIND', 'DIRTY']) {
    const result = runPreflight(mergeState);
    assert.equal(result.status, 0);
    assert.equal(result.commented, true);
    assert.equal(result.labelRemoved, true);
    assert.equal(result.labelRestored, false);
    assert.equal(result.updatedBranch, false);
    assert.equal(result.skipped, true);
    assert.match(result.calls, new RegExp(`merge_state=${mergeState}`));
  }

  const existing = runPreflight('BEHIND', { existingHead: 'current-head' });
  assert.equal(existing.commented, false, '같은 head marker가 두 번째 page에 있어도 안내를 중복 게시하지 않는다');
  assert.equal(existing.labelRemoved, true);

  const advancedHead = runPreflight('BEHIND', { existingHead: 'previous-head' });
  assert.equal(advancedHead.commented, true, '새 head에는 이전 안내와 별도로 rebase 안내를 게시한다');
  assert.equal(advancedHead.labelRemoved, true);

  const changedHead = runPreflight('BEHIND', { headReads: ['new-head'] });
  assert.equal(changedHead.labelRemoved, false, 'head가 바뀌면 새 head의 automerge label을 제거하지 않는다');
  assert.equal(changedHead.labelRestored, false);
  assert.equal(changedHead.commented, false, 'label을 유지한 head에 handoff 댓글을 남기지 않는다');

  const unreadableHead = runPreflight('BEHIND', { headReadFails: [1] });
  assert.equal(unreadableHead.labelRemoved, false, 'current head를 다시 읽지 못하면 automerge label을 제거하지 않는다');
  assert.equal(unreadableHead.labelRestored, false);
  assert.equal(unreadableHead.commented, false);

  const changedAfterRemoval = runPreflight('BEHIND', { headReads: ['current-head', 'new-head'] });
  assert.equal(changedAfterRemoval.labelRemoved, true);
  assert.equal(changedAfterRemoval.labelRestored, true, 'label 제거 뒤 head가 바뀌면 automerge label을 복구한다');
  assert.equal(changedAfterRemoval.commented, false, 'label을 복구한 head에 handoff 댓글을 남기지 않는다');

  const unreadableAfterRemoval = runPreflight('BEHIND', { headReadFails: [2] });
  assert.equal(unreadableAfterRemoval.labelRemoved, true);
  assert.equal(unreadableAfterRemoval.labelRestored, true, 'label 제거 뒤 head를 읽지 못하면 automerge label을 복구한다');
  assert.equal(unreadableAfterRemoval.commented, false);

  const restoreFailed = runPreflight('BEHIND', { headReads: ['current-head', 'new-head'], restoreFails: true });
  assert.equal(restoreFailed.status, 1, 'automerge label 복구 실패는 fail closed여야 한다');

  const unreadable = runPreflight('BEHIND', { commentReadFails: true });
  assert.equal(unreadable.commented, false, 'comment history를 확정하지 못하면 재게시하지 않는다');
  assert.equal(unreadable.labelRemoved, true);

  const commentFailed = runPreflight('DIRTY', { commentFails: true });
  assert.equal(commentFailed.status, 0, '안내 실패가 label 제거를 막으면 안 된다');
  assert.equal(commentFailed.labelRemoved, true);

  const labelFailed = runPreflight('BEHIND', { labelFails: true });
  assert.equal(labelFailed.status, 1, 'label 제거 실패는 fail closed여야 한다');
});

test('merge-state 분기는 상태별로 병합·물러남·건너뛰기를 구분한다', async () => {
  const workflow = await readWorkflow();

  const dispatchBlock = workflow.match(
    /# merge-state-dispatch-begin\n([\s\S]*?)\n\s+# merge-state-dispatch-end/,
  )?.[1];
  assert.ok(dispatchBlock, 'merge state dispatch must stay testable');

  const ownerHandoff = workflow.match(
    /# owner-handoff-begin\n([\s\S]*?)\n\s+# owner-handoff-end/,
  )?.[1];
  assert.ok(ownerHandoff, 'owner handoff must stay testable');
  const transferableCodeRabbitReview = {
    id: 1,
    state: 'COMMENTED',
    submitted_at: '2026-08-01T00:00:00Z',
    commit_id: 'old-head',
    author_association: 'NONE',
    body: '',
    user: { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' },
  };

  // gh 호출을 기록만 하는 스텁으로 대체해 상태별 분기 결과를 실측한다. 분기는 큐 루프
  // 안에 있으므로 `continue`가 유효하도록 1회 루프로 감싸고, 루프를 빠져나오면
  // SKIPPED를 남겨 "이 후보를 건너뛰었다"를 관측한다.
  const runDispatch = (
    mergeState,
    {
      mergeFailureStatus = null,
      commentFails = false,
      hasPat = false,
      updateStatus = 0,
      recordStatus = 0,
      baseUpdateRecords = [],
      reviews = [transferableCodeRabbitReview],
      commits = [{ sha: 'old-head' }],
    } = {},
  ) => {
    const markerSync = workflow.match(MARKER_SYNC_RE)?.[1];
    assert.ok(markerSync, 'authorization marker sync must stay testable');
    const result = stubbedBash([
      'set -euo pipefail',
      `HAS_AUTOMERGE_PAT=${hasPat}`,
      'GH_TOKEN=github-token',
      `base_update_records=${JSON.stringify(JSON.stringify(baseUpdateRecords))}`,
      `reviews=${JSON.stringify(JSON.stringify([reviews]))}`,
      `commits=${JSON.stringify(JSON.stringify([commits]))}`,
      `read_pages() { printf '%s' '[[]]'; }`,
      'gh() {',
      `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
      '  case "$*" in',
      `    "api --method PUT "*update-branch*) printf 'UPDATE_BRANCH_TOKEN=%s\\n' "$GH_TOKEN" >> "$GH_LOG"; return ${updateStatus} ;;`,
      `    "api --method "*"requested: "*) printf 'RECORD_TOKEN=%s\\n' "$GH_TOKEN" >> "$GH_LOG"; return ${recordStatus} ;;`,
      `    "pr view "*"--json headRefOid --jq .headRefOid") printf '%s\\n' "$head" ;;`,
      `    "pr merge"*) ${mergeFailureStatus ?? ':'} ;;`,
      `    "pr comment"*) ${commentFails ? 'return 41' : ':'} ;;`,
      '    "pr edit"*) ;;',
      '  esac',
      '}',
      'pr=26',
      'repo=o/r',
      'head=old-head',
      'GITHUB_SERVER_URL=https://github.com',
      'GITHUB_REPOSITORY=o/r',
      'MERGE_GH_TOKEN=merge-token',
      'GITHUB_RUN_ID=1234',
      `merge_state=${JSON.stringify(mergeState)}`,
      dedent(markerSync),
      dedent(ownerHandoff),
      'for _ in 1; do',
      dedent(dispatchBlock, 12),
      'done',
      `printf 'SKIPPED\\n' >> "$GH_LOG"`,
    ]);
    return {
      status: result.status,
      merged: result.calls.includes('gh pr merge'),
      skipped: result.calls.includes('SKIPPED'),
      warned: (result.stdout + result.stderr).includes('::warning::'),
      commented: result.calls.includes('gh pr comment'),
      labelRemoved: result.calls.includes('--remove-label automerge'),
      calls: result.calls,
    };
  };

  // 병합 가능 상태. UNSTABLE은 "필수가 아닌 check가 green이 아님"일 뿐이고 required
  // context는 앞에서 ruleset 기준으로 이미 검증했으므로 병합을 진행한다.
  for (const mergeState of ['CLEAN', 'HAS_HOOKS', 'UNSTABLE']) {
    const result = runDispatch(mergeState);
    assert.deepEqual(
      {
        status: result.status,
        merged: result.merged,
        skipped: result.skipped,
        warned: result.warned,
        commented: result.commented,
        labelRemoved: result.labelRemoved,
      },
      {
        status: 0,
        merged: true,
        skipped: false,
        warned: false,
        commented: false,
        labelRemoved: false,
      },
      `${mergeState} must proceed to merge`,
    );
    // 이 저장소는 auto-merge가 꺼져 있으므로 즉시 병합이고, head 고정은 서버가 한다.
    assert.match(result.calls, /gh pr merge --squash 26 --repo o\/r --match-head-commit old-head/);
  }
  // 병합할 수 없는 상태는 전부 "이 후보만 건너뛴다"로 수렴한다. 실행을 실패시키면
  // 그 실패 check가 PR을 UNSTABLE로 만들고 큐 전체가 뒤의 후보까지 굶긴다.
  for (const mergeState of ['BLOCKED', 'UNKNOWN']) {
    const result = runDispatch(mergeState);
    assert.equal(result.status, 0, `${mergeState} must not fail the run`);
    assert.equal(result.merged, false);
    assert.equal(result.skipped, true, `${mergeState} must skip to the next candidate`);
    assert.equal(result.warned, false);
    assert.equal(result.commented, false);
    assert.equal(result.labelRemoved, false);
  }
  // 사람이 봐야 하는 상태는 건너뛰되 신호를 남긴다. 실행은 실패시키지 않는다.
  for (const mergeState of ['SOME_NEW_STATE']) {
    const result = runDispatch(mergeState);
    assert.equal(result.status, 0, `${mergeState} must not fail the run`);
    assert.equal(result.merged, false);
    assert.equal(result.skipped, true);
    assert.equal(result.warned, true, `${mergeState} must skip with an operator-visible warning`);
    assert.equal(result.commented, false);
    assert.equal(result.labelRemoved, false);
  }
  const recordLine = 'gh api --method POST repos/o/r/issues/26/comments -f body=<!-- Automerge base update requested: old-head -->';
  const behindWithPat = runDispatch('BEHIND', { hasPat: true });
  assert.equal(behindWithPat.status, 0);
  assert.equal(behindWithPat.merged, false);
  assert.equal(behindWithPat.skipped, false, 'base update must end the run');
  assert.equal(behindWithPat.labelRemoved, false);
  assert.deepEqual(
    behindWithPat.calls.split('\n').filter((line) => line.includes('update-branch')),
    ['gh api --method PUT repos/o/r/pulls/26/update-branch -f expected_head_sha=old-head'],
  );
  assert.match(behindWithPat.calls, /^UPDATE_BRANCH_TOKEN=merge-token$/m);
  assert.ok(behindWithPat.calls.includes(recordLine), 'an accepted base update must be recorded');
  assert.ok(behindWithPat.calls.indexOf('update-branch') < behindWithPat.calls.indexOf(recordLine));
  assert.match(behindWithPat.calls, /^RECORD_TOKEN=github-token$/m);
  const oldHeadHex = 'a'.repeat(40);
  for (const [reviews, commits] of [
    [
      [
        {
          id: 1,
          state: 'APPROVED',
          submitted_at: '2026-08-01T00:00:00Z',
          commit_id: 'old-head',
          author_association: 'OWNER',
          body: '',
          user: { login: 'reviewer', type: 'User' },
        },
      ],
      [{ sha: 'old-head' }],
    ],
    [
      [
        {
          id: 1,
          state: 'COMMENTED',
          submitted_at: '2026-08-01T00:00:00Z',
          commit_id: oldHeadHex,
          author_association: 'OWNER',
          body: `<!-- pstack-interrogate head=${oldHeadHex} act-on=0 -->`,
          user: { login: 'reviewer', type: 'User' },
        },
      ],
      [{ sha: oldHeadHex }],
    ],
    [
      [
        {
          id: 1,
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-08-01T00:00:00Z',
          commit_id: oldHeadHex,
          author_association: 'OWNER',
          body: '',
          user: { login: 'reviewer', type: 'User' },
        },
        {
          id: 2,
          state: 'COMMENTED',
          submitted_at: '2026-08-01T00:01:00Z',
          commit_id: oldHeadHex,
          author_association: 'OWNER',
          body: `<!-- pstack-interrogate head=${oldHeadHex} act-on=0 -->`,
          user: { login: 'reviewer', type: 'User' },
        },
        { ...transferableCodeRabbitReview, id: 3, commit_id: oldHeadHex },
      ],
      [{ sha: oldHeadHex }],
    ],
  ]) {
    const behindNonTransferable = runDispatch('BEHIND', {
      hasPat: true,
      reviews,
      commits,
    });
    assert.equal(behindNonTransferable.status, 0);
    assert.equal(behindNonTransferable.skipped, true, 'non-transferable BEHIND must hand off and continue');
    assert.equal(behindNonTransferable.labelRemoved, true);
    assert.equal(behindNonTransferable.commented, true);
    assert.doesNotMatch(behindNonTransferable.calls, /update-branch/);
  }
  const behindRecorded = runDispatch('BEHIND', { hasPat: true, baseUpdateRecords: [{ id: 7, head: 'a'.repeat(40) }] });
  assert.ok(behindRecorded.calls.includes('gh api --method PATCH repos/o/r/issues/comments/7 -f body=<!-- Automerge base update requested: old-head -->'));
  assert.doesNotMatch(behindRecorded.calls, /--method POST/);
  const behindAmbiguous = runDispatch('BEHIND', { hasPat: true, baseUpdateRecords: [{ id: 7, head: 'a'.repeat(40) }, { id: 8, head: 'b'.repeat(40) }] });
  assert.equal(behindAmbiguous.status, 0);
  assert.equal(behindAmbiguous.skipped, false);
  assert.doesNotMatch(behindAmbiguous.calls, /requested: /, 'ambiguous records must not be touched');
  assert.equal(behindAmbiguous.warned, true);
  const behindRecordFailed = runDispatch('BEHIND', { hasPat: true, recordStatus: 49 });
  assert.equal(behindRecordFailed.status, 0, 'a record failure must not fail the run after the accepted update');
  assert.equal(behindRecordFailed.skipped, false);
  assert.equal(behindRecordFailed.warned, true);
  const behindUpdateFailed = runDispatch('BEHIND', { hasPat: true, updateStatus: 42 });
  assert.equal(behindUpdateFailed.status, 0, 'a failed base update must skip only this candidate');
  assert.equal(behindUpdateFailed.skipped, true);
  assert.equal(behindUpdateFailed.merged, false);
  assert.equal(behindUpdateFailed.labelRemoved, false);
  assert.equal(behindUpdateFailed.warned, true);
  assert.doesNotMatch(behindUpdateFailed.calls, /requested: /, 'a failed base update must not be recorded');
  // PAT 없는 BEHIND는 preflight가 먼저 handoff한다. 분기에 닿더라도 branch를 바꾸지 않는다.
  const behindWithoutPat = runDispatch('BEHIND');
  assert.equal(behindWithoutPat.skipped, true);
  assert.doesNotMatch(behindWithoutPat.calls, /update-branch/);
  assert.equal(behindWithoutPat.warned, true);
  // 병합 API 호출 실패는 PR에 실패 상태를 남기고 라벨을 제거한 뒤 즉시 실패한다.
  const mergeFailed = runDispatch('CLEAN', { mergeFailureStatus: 'return 17' });
  assert.equal(mergeFailed.status, 17, 'merge call failure must preserve the failed status');
  assert.equal(mergeFailed.commented, true, 'merge failure must be visible on the PR');
  assert.equal(mergeFailed.labelRemoved, true, 'merge failure must remove automerge');
  assert.match(mergeFailed.calls, /병합 호출/);
  assert.match(mergeFailed.calls, /merge_state=CLEAN/);
  assert.match(mergeFailed.calls, /exit status=17/);
  assert.match(mergeFailed.calls, /https:\/\/github\.com\/o\/r\/actions\/runs\/1234/);
  const commentFailed = runDispatch('CLEAN', { mergeFailureStatus: 'return 17', commentFails: true });
  assert.equal(commentFailed.status, 17, 'comment failure must not replace the merge status');
  assert.equal(commentFailed.commented, true, 'failure comment must still be attempted');
  assert.equal(commentFailed.labelRemoved, true, 'comment failure must still remove automerge');
});

test('게이트는 후보별로 병합 분기보다 앞선다', async () => {
  const workflow = await readWorkflow();

  // 게이트는 후보마다 수행되고, 통과하지 못하면 그 후보만 건너뛴다. 순서 계약은 유지한다.
  assert.ok(workflow.includes('set -euo pipefail'));
  const queueLoopAt = workflow.indexOf('# queue-loop-begin');
  const reviewGateAt = workflow.indexOf('# review-state-filter-end');
  const contextGateAt = workflow.indexOf('# required-context-filter-end');
  const dispatchAt = workflow.indexOf('# merge-state-dispatch-begin');
  assert.ok(queueLoopAt > 0, 'queue loop marker must exist');
  // 큐 루프 → 리뷰 게이트 → required context 게이트 → 병합 분기.
  assert.ok(reviewGateAt > queueLoopAt, 'gates must run inside the candidate loop');
  assert.ok(contextGateAt > reviewGateAt, 'review gate must precede the required context gate');
  assert.ok(dispatchAt > contextGateAt, 'gates must precede the merge dispatch');
});

const BUDGET_BLOCK_RE = /# candidate-budget-begin\n([\s\S]*?)\n\s+# candidate-budget-end/;
// 상수와 jq 질의만 담은 조각. 하네스가 이 블록을 그대로 주입하므로 워크플로에서 상수를
// 바꾸면 하네스도 같이 따라간다 — 테스트가 값을 따로 들고 있으면 계약이 실제 동작과
// 어긋난 채 통과한다.
const BUDGET_CONSTANTS_RE = /# budget-constants-begin\n([\s\S]*?)\n\s+# budget-constants-end/;
const budgetConstantsOf = (workflow) => {
  const block = workflow.match(BUDGET_CONSTANTS_RE)?.[1];
  assert.ok(block, 'budget constants block must stay testable');
  return dedent(block);
};

const budgetConstantOf = (workflow, name) => {
  const block = workflow.match(BUDGET_BLOCK_RE)?.[1];
  assert.ok(block, 'candidate budget block must stay testable');
  const declared = Number(block.match(new RegExp(`^\\s*${name}=(\\d+)$`, 'm'))?.[1]);
  assert.ok(Number.isInteger(declared), `${name} constant must stay declared`);
  return declared;
};

// 실제 창은 실행마다 실측 잔량에서 정해지므로 상수로 남는 것은 상한뿐이다.
const declaredWindowOf = (workflow) => {
  const declared = budgetConstantOf(workflow, 'window_max');
  assert.ok(declared > 0, 'window ceiling must stay positive');
  return declared;
};

const WINDOW_PROGRAM_RE =
  /# candidate-window-begin\n\s+done < <\(jq -r --argjson window "\$\{window\}" --argjson offset "\$\{offset\}" '\n([\s\S]*?)\n\s+' <<<"\$\{candidates\}"\)/;

const makePickWindow = (windowProgram, windowSize) => (total, offset) => {
  const result = spawnSync(
    'jq',
    [
      '-r',
      '--argjson', 'window', String(windowSize),
      '--argjson', 'offset', String(offset),
      windowProgram,
    ],
    {
      input: JSON.stringify(Array.from({ length: total }, (_, index) => index)),
      encoding: 'utf8',
    },
  );
  // 실패한 jq도 stdout이 비어 "선택 없음"처럼 보인다. 프로그램 파손이 정상 동작으로
  // 새지 않도록 종료 코드를 함께 본다.
  assert.equal(
    result.status,
    0,
    `candidate window jq failed at total=${total} offset=${offset}: ${result.stderr}`,
  );
  const stdout = result.stdout.trim();
  return stdout === '' ? [] : stdout.split('\n').map(Number);
};

// 큐 루프를 통째로 돌리는 하네스. `gh` 호출을 픽스처 파일 조회로 대체해 후보별 게이트와
// 건너뛰기를 실측한다. runNumber는 실행 컨텍스트 주입값이며 결과가 여기 좌우되면 안 된다.
const makeRunQueue =
  (queueLoop, budgetConstants) =>
  (prs, { runNumber = 0, window = null, offset = null, remaining = [5000], hasPat = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'automerge-queue-loop-'));
  const log = join(dir, 'gh.log');
  // 잔량은 호출 순서대로 소비하고 목록이 끝나면 마지막 값을 반복한다. 루프 안 재확인이
  // 실제로 다시 읽는지 보려면 실행 도중 값이 바뀌어야 한다.
  writeFileSync(join(dir, 'rates'), `${remaining.join('\n')}\n`);
  for (const pr of prs) {
    const head = String(pr.number).padStart(40, '0');
    const dependabot = {
      login: pr.dependabotLogin ?? 'dependabot[bot]',
      id: pr.dependabotId ?? 49699333,
      type: pr.dependabotType ?? 'Bot',
    };
    writeFileSync(
      join(dir, `pr-${pr.number}.json`),
      JSON.stringify({
        state: pr.state ?? 'OPEN',
        isDraft: false,
        baseRefName: 'main',
        labels: [{ name: 'automerge' }],
        headRefName: `feature-${pr.number}`,
        headRefOid: head,
        headRepository: { nameWithOwner: 'o/r' },
        mergeStateStatus: pr.mergeStateStatus,
      }),
    );
    writeFileSync(
      join(dir, `comments-${pr.number}.json`),
      JSON.stringify(
        [
          ...(pr.authorized === false
            ? []
            : [
                {
                  id: 9,
                  body: `<!-- Automerge frozen discovery authorization: ${head} -->`,
                  user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
                },
              ]),
          ...(pr.hasRebaseMarker
            ? [{ body: `<!-- easysubway-automerge-rebase-required:${head} -->` }]
            : []),
        ],
      ),
    );
    writeFileSync(
      join(dir, `reviews-${pr.number}.json`),
      JSON.stringify(
        pr.reviewed === false
          ? []
          : pr.codeRabbitReviewed
            ? [
                {
                  id: 1,
                  state: 'COMMENTED',
                  submitted_at: '2026-08-01T00:00:00Z',
                  commit_id: pr.reviewCommit ?? head,
                  author_association: 'NONE',
                  body: '',
                  user: { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' },
                },
              ]
            : [
                {
                  id: 1,
                  state: 'APPROVED',
                  submitted_at: '2026-08-01T00:00:00Z',
                  commit_id: pr.reviewCommit ?? head,
                  author_association: 'OWNER',
                  body: '',
                  user: { login: 'reviewer', type: 'User' },
                },
              ],
      ),
    );
    writeFileSync(
      join(dir, `commits-${pr.number}.json`),
      JSON.stringify(
        Array.from(
          { length: pr.dependencyCommitCount ?? 1 },
          (_, index) => ({
            sha: pr.commitHistory?.[index] ?? (index === 0 ? head : `previous-${index}`),
            author: pr.dependabotCompose ? dependabot : { login: 'owner', id: 1, type: 'User' },
          }),
        ),
      ),
    );
    writeFileSync(
      join(dir, `rest-${pr.number}.json`),
      JSON.stringify({
        head: {
          sha: pr.dependencyHead ?? head,
          ref: pr.dependencyRef ?? `feature-${pr.number}`,
          repo: { full_name: pr.dependencyRepository ?? 'o/r' },
        },
        user: pr.dependabotCompose ? dependabot : { login: 'owner', id: 1, type: 'User' },
      }),
    );
    if (pr.restReadFails) writeFileSync(join(dir, `rest-fail-${pr.number}`), '1');
    writeFileSync(
      join(dir, `runs-${head}.json`),
      pr.workflowRunsMalformed ? '{' : JSON.stringify({
        total_count: pr.workflowRunTotalCount ?? 1,
        workflow_runs: pr.workflowRunsOverflow
          ? Array.from({ length: 100 }, () => ({}))
          : [{
              workflow_id: pr.workflowRunId ?? 324173434,
              head_sha: pr.workflowRunHead ?? head,
              head_branch: pr.workflowRunBranch ?? `feature-${pr.number}`,
              event: pr.workflowRunEvent ?? 'pull_request',
              repository: { full_name: pr.workflowRunRepository ?? 'o/r' },
              head_repository: { full_name: pr.workflowRunHeadRepository ?? 'o/r' },
              actor: pr.workflowRunActor ?? dependabot,
              triggering_actor: pr.workflowRunTriggeringActor ?? dependabot,
            }],
      }),
    );
    if (pr.workflowRunsFail) writeFileSync(join(dir, `runs-fail-${head}`), '1');
    writeFileSync(
      join(dir, `files-${pr.number}.json`),
      pr.filesMalformed ? '{' : JSON.stringify(pr.filesOverflow
        ? Array.from({ length: 100 }, () => ({ filename: 'infra/docker-compose.yml' }))
        : [
        {
          filename: pr.dependencyFile ?? 'infra/docker-compose.yml',
          patch: Object.hasOwn(pr, 'dependencyPatch')
            ? pr.dependencyPatch
            : '-    image: ghcr.io/a/image:1.0.0\n+    image: ghcr.io/a/image:1.0.1',
          additions: pr.dependencyAdditions ?? 1,
          deletions: pr.dependencyDeletions ?? 1,
          changes: pr.dependencyChanges ?? 2,
        },
      ]),
    );
    writeFileSync(
      join(dir, `threads-${pr.number}.json`),
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: pr.unresolvedThread ? [{ isResolved: false }] : [],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      }),
    );
    // `pending`은 conclusion이 null인 상태다. null 병합 연산자로 접으면 success로 새므로
    // 명시 분기로 둔다.
    const conclusion =
      pr.checkState === 'failure' ? 'failure' : pr.checkState === 'pending' ? null : 'success';
    writeFileSync(
      join(dir, `checks-${head}.json`),
      JSON.stringify({
        check_runs:
          pr.checkState === 'missing'
            ? []
            : [
                {
                  id: 1,
                  name: 'Platform CI',
                  conclusion,
                  started_at: '2026-08-01T00:00:00Z',
                },
              ],
      }),
    );
    writeFileSync(join(dir, `statuses-${head}.json`), JSON.stringify([]));
  }
  const script = [
    'set -euo pipefail',
    `GH_LOG=${JSON.stringify(log)}`,
    `FIX=${JSON.stringify(dir)}`,
    `GITHUB_RUN_NUMBER=${JSON.stringify(String(runNumber))}`,
    ': > "$GH_LOG"',
    'gh() {',
    `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
    '  local all="$*"',
    '  case "$all" in',
    // 잔량 조회의 jq 프로그램이 `.resources.graphql.remaining`을 담고 있어 아래
    // `*graphql*`에 먼저 걸린다. 좁은 패턴을 앞에 둔다. 스텁은 `--jq` 적용 결과를 낸다.
    '    *rate_limit*)',
    '      rn=$(cat "$FIX/ratecount" 2>/dev/null || printf 0); rn=$((rn + 1))',
    '      printf %s "$rn" > "$FIX/ratecount"',
    '      rv="$(sed -n "${rn}p" "$FIX/rates")"',
    '      [ -n "$rv" ] || rv="$(tail -1 "$FIX/rates")"',
    `      printf '%s\\n' "$rv" ;;`,
    `    "pr list"*) printf '%s\\n' ${JSON.stringify(JSON.stringify(prs.map((p) => p.number)))} ;;`,
    // 쓰기 호출은 `*repos/*/pulls/*` 같은 읽기 패턴보다 먼저 둔다.
    `    "api --method PUT repos/o/r/pulls/"*"/update-branch "*) printf 'TOKEN=%s\\n' "$GH_TOKEN" >> "$GH_LOG" ;;`,
    `    "api --method PATCH repos/o/r/issues/comments/"*|"api --method POST repos/o/r/issues/"*"/comments "*) printf 'TOKEN=%s\\n' "$GH_TOKEN" >> "$GH_LOG"; jq -nc --arg body "\${all#*body=}" '{id: 77, body: $body, user: {login: "github-actions[bot]", id: 41898282, type: "Bot"}}' ;;`,
    // marker 복구 판정용 이벤트. 픽스처가 없으므로 복구는 fail-closed로 끝난다.
    '    *issues/*/events*) return 1 ;;',
    '    "pr view "*"--json headRefOid --jq .headRefOid") set -- $all; jq -r .headRefOid "$FIX/pr-$3.json" ;;',
    '    "pr view "*) set -- $all; cat "$FIX/pr-$3.json" ;;',
    '    *repos/*/pulls/*/files*) n="${all#*pulls/}"; n="${n%%/files*}"; cat "$FIX/files-$n.json" ;;',
    '    *issues/*/comments*) n="${all#*issues/}"; n="${n%%/comments*}"; cat "$FIX/comments-$n.json" ;;',
    '    *pulls/*/commits*) n="${all#*pulls/}"; n="${n%%/commits*}"; cat "$FIX/commits-$n.json" ;;',
    '    *pulls/*/reviews*) n="${all#*pulls/}"; n="${n%%/reviews*}"; cat "$FIX/reviews-$n.json" ;;',
    '    *actions/runs*) h="${all#*head_sha=}"; h="${h%%&*}"; [ -f "$FIX/runs-fail-$h" ] && return 1; cat "$FIX/runs-$h.json" ;;',
    '    *repos/*/pulls/*) n="${all#*pulls/}"; n="${n%% *}"; [ -f "$FIX/rest-fail-$n" ] && return 1; cat "$FIX/rest-$n.json" ;;',
    '    *graphql*) n="${all#*number=}"; n="${n%% *}"; cat "$FIX/threads-$n.json" ;;',
    '    *check-runs*) h="${all#*commits/}"; h="${h%%/check-runs*}"; cat "$FIX/checks-$h.json" ;;',
    '    *statuses*) h="${all#*commits/}"; h="${h%%/statuses*}"; cat "$FIX/statuses-$h.json" ;;',
    // 응답이 필요 없는 실제 동작. 로그에만 남기고 조용히 성공한다.
    '    "pr merge"* | "pr comment"* | "pr edit"* | "workflow run"*) ;;',
    // 기본 분기가 없으면 워크플로가 새 gh 호출을 늘렸을 때 스텁이 빈 출력 + 종료 코드 0을
    // 낸다. 큐 루프는 그것을 "빈 API 응답"으로 읽고 후보를 건너뛰므로, 하네스가 덮지 못한
    // 호출이 조용히 통과한다. 실패시켜 즉시 드러낸다.
    `    *) printf 'unstubbed gh call: %s\\n' "$all" >&2; return 1 ;;`,
    '  esac',
    '}',
    'repo=o/r',
    'owner=o',
    'name=r',
    'GITHUB_SERVER_URL=https://github.com',
    'GITHUB_REPOSITORY=o/r',
    'MERGE_GH_TOKEN=merge-token',
    'GITHUB_RUN_ID=1234',
    'GH_TOKEN=github-token',
    `HAS_AUTOMERGE_PAT=${hasPat}`,
    `required='[{"context":"Platform CI","integration_id":null}]'`,
    'candidates="$(gh pr list)"',
    budgetConstants,
    ...(window === null ? [] : [`window=${window}`]),
    ...(offset === null ? [] : [`offset=${offset}`]),
    dedent(queueLoop),
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const merged = calls.match(/gh pr merge [^\n]*?(\d+) --repo/)?.[1];
  return {
    status: result.status,
    mergedPr: merged ? Number(merged) : null,
    // 후보 평가 1건당 1회의 metadata 조회만 세야 한다.
    evaluated: [...calls.matchAll(/gh pr view (\d+) --repo [^\n]*--json baseRefName/g)].map((m) =>
      Number(m[1]),
    ),
    updatedBranch: calls.includes('update-branch'),
    dispatchedCi: calls.includes('workflow run ci.yml'),
    commented: calls.includes('gh pr comment'),
    labelRemoved: calls.includes('--remove-label automerge'),
    rateCalls: (calls.match(/gh api rate_limit/g) ?? []).length,
    calls,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

test('막힌 후보는 뒤의 후보를 굶기지 않고 게이트는 후보별로 그대로 강제된다', async () => {
  const workflow = await readWorkflow();
  const queueLoop = workflow.match(
    /# queue-loop-begin\n([\s\S]*?)\n\s+# queue-loop-end/,
  )?.[1];
  assert.ok(queueLoop, 'queue loop must stay testable');
  const runQueue = makeRunQueue(queueLoop, budgetConstantsOf(workflow));

  // 큐 head가 BLOCKED이어도 뒤의 병합 가능한 후보가 처리된다. 이것이 이 설계의 핵심이다.
  assert.equal(
    runQueue([
      { number: 1, mergeStateStatus: 'BLOCKED' },
      { number: 2, mergeStateStatus: 'CLEAN' },
    ]).mergedPr,
    2,
  );
  // 충돌한 후보도 뒤를 막지 않는다.
  const dirtyQueue = runQueue([
    { number: 1, mergeStateStatus: 'DIRTY' },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ]);
  assert.equal(dirtyQueue.mergedPr, 2);
  // 계약 위반이 신호 없이 묻히면 안 된다.
  assert.match(dirtyQueue.stdout + dirtyQueue.stderr, /::warning::/);
  // 게이트는 후보별로 그대로 강제된다 — 리뷰 객체가 없는 후보는 병합되지 않는다.
  assert.equal(
    runQueue([
      { number: 1, mergeStateStatus: 'CLEAN', reviewed: false },
      { number: 2, mergeStateStatus: 'CLEAN' },
    ]).mergedPr,
    2,
  );
  // 라벨 뒤 push는 label-head marker와 SHA가 달라진다. 새 marker 없이 prior discovery를
  // 승계하면 안 되므로 이 후보만 fail closed하고 뒤 후보를 계속 평가한다.
  assert.equal(
    runQueue([
      { number: 1, mergeStateStatus: 'CLEAN', authorized: false },
      { number: 2, mergeStateStatus: 'CLEAN' },
    ]).mergedPr,
    2,
  );
  // force-push로 reviewed commit이 current PR history에서 제거된 후보도 건너뛴다.
  assert.equal(
    runQueue([
      {
        number: 1,
        mergeStateStatus: 'CLEAN',
        reviewCommit: 'removed-head',
        commitHistory: [String(1).padStart(40, '0')],
      },
      { number: 2, mergeStateStatus: 'CLEAN' },
    ]).mergedPr,
    2,
  );
  // 미해결 thread가 있는 후보도 건너뛴다.
  assert.equal(
    runQueue([
      { number: 1, mergeStateStatus: 'CLEAN', unresolvedThread: true },
      { number: 2, mergeStateStatus: 'CLEAN' },
    ]).mergedPr,
    2,
  );
  // required context가 실패·대기·미부착인 후보도 각각 건너뛴다.
  for (const checkState of ['failure', 'pending', 'missing']) {
    assert.equal(
      runQueue([
        { number: 1, mergeStateStatus: 'CLEAN', checkState },
        { number: 2, mergeStateStatus: 'CLEAN' },
      ]).mergedPr,
      2,
      `required context ${checkState} must skip only that candidate`,
    );
  }
  // BEHIND는 required context와 무관하게 먼저 라벨을 내려 branch owner에게 넘긴다.
  const behindMissing = runQueue([
    { number: 1, mergeStateStatus: 'BEHIND', checkState: 'missing' },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ]);
  assert.equal(behindMissing.status, 0);
  assert.equal(behindMissing.updatedBranch, false);
  assert.equal(behindMissing.commented, true);
  assert.equal(behindMissing.labelRemoved, true);
  assert.equal(behindMissing.mergedPr, 2);
  assert.deepEqual(behindMissing.evaluated, [1, 2]);

  // 부재는 건너뛰기만 하는 것이 아니라 CI를 쏴서 교착을 푼다. 그러면서도 뒤의 병합 가능한
  // 후보를 굶기지 않아야 한다 — 이 dispatch는 실행을 끝내지 않는다.
  const missingContext = runQueue([
    { number: 1, mergeStateStatus: 'CLEAN', checkState: 'missing' },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ]);
  assert.equal(missingContext.dispatchedCi, true, 'required context 부재는 CI dispatch로 푼다');
  assert.equal(missingContext.mergedPr, 2);
  // 게이트를 통과한 가장 오래된 후보가 우선한다(best-effort FIFO).
  assert.equal(
    runQueue([
      { number: 1, mergeStateStatus: 'CLEAN' },
      { number: 2, mergeStateStatus: 'CLEAN' },
    ]).mergedPr,
    1,
  );
  // 실제 동작은 한 실행에 최대 한 건이다. 병합 직렬화가 유지되어야 한다.
  const serialized = runQueue([
    { number: 1, mergeStateStatus: 'CLEAN' },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ]);
  assert.equal(serialized.evaluated.length, 1, '병합하면 그 실행은 거기서 끝난다');
  // BEHIND handoff는 branch를 바꾸지 않고 뒤의 병합 가능한 후보도 굶기지 않는다.
  const behind = runQueue([
    { number: 1, mergeStateStatus: 'BEHIND' },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ]);
  assert.equal(behind.status, 0);
  assert.equal(behind.mergedPr, 2);
  assert.deepEqual(behind.evaluated, [1, 2]);
  assert.equal(behind.updatedBranch, false);
  assert.equal(behind.dispatchedCi, false);
  assert.equal(behind.labelRemoved, true);
  const behindWithPat = runQueue([
    { number: 1, mergeStateStatus: 'BEHIND', codeRabbitReviewed: true },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ], { hasPat: true });
  assert.equal(behindWithPat.status, 0, behindWithPat.stderr);
  assert.equal(behindWithPat.mergedPr, null);
  assert.deepEqual(behindWithPat.evaluated, [1]);
  assert.equal(behindWithPat.labelRemoved, false);
  assert.match(
    behindWithPat.calls,
    new RegExp(`gh api --method PUT repos/o/r/pulls/1/update-branch -f expected_head_sha=${String(1).padStart(40, '0')}\\n`),
  );
  const behindNonTransferableWithPat = runQueue([
    { number: 1, mergeStateStatus: 'BEHIND' },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ], { hasPat: true });
  assert.equal(behindNonTransferableWithPat.status, 0, behindNonTransferableWithPat.stderr);
  assert.equal(behindNonTransferableWithPat.updatedBranch, false);
  assert.equal(behindNonTransferableWithPat.labelRemoved, true);
  assert.equal(behindNonTransferableWithPat.commented, true);
  assert.equal(behindNonTransferableWithPat.mergedPr, 2);
  for (const blocked of [
    { number: 1, mergeStateStatus: 'BEHIND', reviewed: false },
    { number: 1, mergeStateStatus: 'BEHIND', codeRabbitReviewed: true, unresolvedThread: true },
    { number: 1, mergeStateStatus: 'BEHIND', codeRabbitReviewed: true, checkState: 'failure' },
  ]) {
    const skipped = runQueue([blocked, { number: 2, mergeStateStatus: 'CLEAN' }], { hasPat: true });
    assert.equal(skipped.status, 0);
    assert.equal(skipped.updatedBranch, false, `gated-out BEHIND must not be updated: ${JSON.stringify(blocked)}`);
    assert.equal(skipped.mergedPr, 2);
  }
  const dirtyWithPat = runQueue([
    { number: 1, mergeStateStatus: 'DIRTY' },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ], { hasPat: true });
  assert.equal(dirtyWithPat.labelRemoved, true, 'DIRTY keeps the owner handoff with the PAT');
  assert.equal(dirtyWithPat.updatedBranch, false);
  assert.equal(dirtyWithPat.mergedPr, 2);
  // 아무 후보도 병합할 수 없으면 병합 없이 성공하며 DIRTY 라벨만 제거한다.
  const allBlocked = runQueue([
    { number: 1, mergeStateStatus: 'BLOCKED' },
    { number: 2, mergeStateStatus: 'DIRTY' },
  ]);
  assert.equal(allBlocked.status, 0);
  assert.equal(allBlocked.mergedPr, null);
  assert.equal(allBlocked.evaluated.length, 2);
  assert.equal(allBlocked.labelRemoved, true);
});

test('exact Dependabot Compose image-only PR만 Review와 marker 없이 통과한다', async () => {
  const workflow = await readWorkflow();
  const queueLoop = workflow.match(
    /# queue-loop-begin\n([\s\S]*?)\n\s+# queue-loop-end/,
  )?.[1];
  assert.ok(queueLoop, 'queue loop must stay testable');
  const runQueue = makeRunQueue(queueLoop, budgetConstantsOf(workflow));

  const tagAndDigest = `ghcr.io/a/image:1.0.1@sha256:${'a'.repeat(64)}`;
  const eligible = runQueue([
    {
      number: 41,
      mergeStateStatus: 'CLEAN',
      reviewed: false,
      authorized: false,
      dependabotCompose: true,
      dependencyPatch: `-    image: ghcr.io/a/image:1.0.0@sha256:${'b'.repeat(64)}\n+    image: ${tagAndDigest}`,
    },
  ]);
  assert.equal(eligible.mergedPr, 41, 'exact dependency-only candidate must bypass only Review and marker');
  // Dependabot Compose PR이 BEHIND면 PAT가 있어도 base를 갱신하지 않고 이전처럼 소유 세션에
  // handoff한다(Review가 없어 게이트를 통과할 수 없는 후보를 라벨이 붙은 채 방치하지 않는다).
  const dependabotBehind = runQueue([
    {
      number: 41,
      mergeStateStatus: 'BEHIND',
      reviewed: false,
      authorized: false,
      dependabotCompose: true,
      dependencyPatch: `-    image: ghcr.io/a/image:1.0.0@sha256:${'b'.repeat(64)}\n+    image: ${tagAndDigest}`,
    },
    { number: 42, mergeStateStatus: 'CLEAN' },
  ], { hasPat: true });
  assert.equal(dependabotBehind.status, 0, dependabotBehind.stderr);
  assert.equal(dependabotBehind.updatedBranch, false, 'a Dependabot Compose BEHIND PR must not be updated by the coordinator');
  assert.equal(dependabotBehind.labelRemoved, true, 'a Dependabot Compose BEHIND PR must be handed off');
  assert.equal(dependabotBehind.commented, true, 'the handoff must leave the rebase notice');
  assert.equal(dependabotBehind.mergedPr, 42, 'the handoff must not starve later candidates');
  const ordinaryBehind = runQueue([{ number: 41, mergeStateStatus: 'BEHIND', codeRabbitReviewed: true }], { hasPat: true });
  assert.equal(ordinaryBehind.updatedBranch, true);
  assert.equal(ordinaryBehind.labelRemoved, false);
  // Review를 건너뛰는 예외 경로는 marker 동기화 대상도 아니다. marker가 없어도 복구하지 않는다.
  assert.doesNotMatch(eligible.calls, /--method (PATCH|POST)|\/events/, 'the Dependabot exception must not sync authorization markers');

  for (const override of [
    { dependabotLogin: 'dependabot-preview[bot]' },
    { dependabotId: 1 },
    { dependabotType: 'User' },
    { dependencyCommitCount: 2 },
    { dependencyHead: 'stale' },
    { dependencyRef: 'other-ref' },
    { dependencyRepository: 'other/repo' },
    { dependencyFile: '.github/workflows/ci.yml' },
    { dependencyPatch: '+ environment:\n+   FOO: bar' },
    { dependencyPatch: '+ image: ghcr.io/a/image:latest', dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: '+ image: ghcr.io/a/image:latest ', dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: '+ image: ghcr.io/a/image:latest\t', dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: '+ image: latest', dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: '+ image: ${EASYSUBWAY_BACKEND_IMAGE}', dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: '+ image: "ghcr.io/a/image:latest"', dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: '+ image: ghcr.io/a/image:latest # comment', dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: `+ image: ghcr.io/a/image:latest@sha256:${'a'.repeat(64)}`, dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: '+ image: ghcr.io/a/image:1.0.1', dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: `+ image: ghcr.io/a/image:@sha256:${'a'.repeat(64)}`, dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: `+ image: ghcr.io/a/image:1.0.1@sha256:${'A'.repeat(64)}`, dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: `+ image: ghcr.io/a/image:1.0.1@sha256:${'a'.repeat(63)}`, dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: `+ image: ghcr.io/a/image:1.0.1@sha256:${'a'.repeat(64)}@sha256:${'b'.repeat(64)}`, dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: '+ image: ${IMAGE}', dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: '+ image: ', dependencyDeletions: 0, dependencyChanges: 1 },
    { dependencyPatch: null, dependencyAdditions: 0, dependencyDeletions: 0, dependencyChanges: 0 },
    { dependencyChanges: 1 },
    { dependencyAdditions: '1' },
    { workflowRunsFail: true },
    { workflowRunsMalformed: true },
    { workflowRunsOverflow: true, workflowRunTotalCount: 100 },
    { workflowRunTotalCount: 2 },
    { workflowRunHead: 'stale' },
    { workflowRunBranch: 'other-ref' },
    { workflowRunRepository: 'other/repo' },
    { workflowRunHeadRepository: 'other/repo' },
    { workflowRunId: 1 },
    { workflowRunEvent: 'push' },
    { workflowRunActor: { login: 'owner', id: 1, type: 'User' } },
    { workflowRunTriggeringActor: { login: 'owner', id: 1, type: 'User' } },
  ]) {
    const rejected = runQueue([
      { number: 41, mergeStateStatus: 'CLEAN', reviewed: false, authorized: false, dependabotCompose: true, ...override },
    ]);
    assert.equal(rejected.mergedPr, null, `invalid dependency candidate must fail closed: ${JSON.stringify(override)}`);
  }

  for (const dependencyPatch of [
    `+ image: ${tagAndDigest}`,
    `+ image: ghcr.io/a/image@sha256:${'a'.repeat(64)}`,
  ]) {
    assert.equal(
      runQueue([{
        number: 41, mergeStateStatus: 'CLEAN', reviewed: false, authorized: false, dependabotCompose: true,
        dependencyPatch, dependencyDeletions: 0, dependencyChanges: 1,
      }]).mergedPr,
      41,
      `pinned literal locator must be admitted: ${dependencyPatch}`,
    );
  }

  for (const mergeStateStatus of ['HAS_HOOKS', 'UNSTABLE', 'BLOCKED']) {
    assert.equal(
      runQueue([{ number: 41, mergeStateStatus, reviewed: false, authorized: false, dependabotCompose: true }]).mergedPr,
      null,
      `Review-less dependency exemption must require CLEAN, got ${mergeStateStatus}`,
    );
  }

  for (const failure of ['restReadFails', 'filesOverflow', 'filesMalformed']) {
    assert.equal(
      runQueue([{ number: 41, mergeStateStatus: 'CLEAN', [failure]: true }]).mergedPr,
      41,
      `ordinary reviewed PR must keep the Review path after ${failure}`,
    );
    assert.equal(
      runQueue([{ number: 41, mergeStateStatus: 'CLEAN', reviewed: false, authorized: false, dependabotCompose: true, [failure]: true }]).mergedPr,
      null,
      `Review-less dependency candidate must fail closed after ${failure}`,
    );
  }

  assert.match(workflow, /# dependabot-compose-exception-begin/);
  assert.match(workflow, /dependabot\[bot\]/);
  assert.match(workflow, /49699333/);
  assert.match(workflow, /infra\/docker-compose\.yml/);
  assert.match(workflow, /EASYSUBWAY_BACKEND_IMAGE/);
});

test('후보 창은 API 지분·timeout·실측 큐 깊이 세 기준으로 유도되고 모든 후보에 도달한다', async () => {
  const workflow = await readWorkflow();

  // 창 크기는 이 저장소 값으로 다시 계산해야 한다. 형제 저장소 상수(backend 6, mobile 20)를
  // 그대로 쓰면 실행당 청구가 이 저장소가 허용하기로 한 지분을 넘는다.
  const declaredWindow = declaredWindowOf(workflow);
  assert.equal(declaredWindow, 3, 'window ceiling must stay pinned to the derived value');
  const rationale = workflow.slice(
    workflow.indexOf('# queue-loop-begin'),
    workflow.indexOf('# candidate-budget-begin'),
  );
  // 근거는 세 기준을 모두 담아야 한다. 하나만 적으면 다음 사람이 다른 쪽을 모른 채 값을 바꾼다.
  for (const basis of [
    '저장소당 시간당 1,000회',
    '5분(300초)',
    '후보 한 건당',
    '고정 비용',
    '실측 큐 깊이',
    // 빈도가 아니라 실측으로 정한다는 것.
    'GET /rate_limit',
    'cancel-in-progress: false',
    // 이 저장소에는 지켜 줘야 할 producer 체인이 없다는 실측과, 그래도 예약분을 두는 이유.
    '큐가 지켜 줘야 할 producer',
    'cd.yml preflight dispatch',
  ]) {
    assert.ok(rationale.includes(basis), `window rationale missing: ${basis}`);
  }
  // 실행 빈도 가정으로 되돌아가면 안 된다. concurrency는 대기 실행만 접을 뿐 실행이
  // 시작되는 빈도에 상한을 두지 않으므로, "N회/시"에서 유도한 상한은 강제되지 않는다.
  assert.doesNotMatch(
    rationale,
    /회\/시/,
    'window must not be derived from an assumed invocation rate',
  );

  // 창 선택 자체. 어떤 시작점에서든 선택 수는 window 이하이고 오래된 순이며,
  // 시작점 전체를 훑으면 모든 후보가 최소 한 번은 창에 들어온다.
  const windowProgram = workflow.match(WINDOW_PROGRAM_RE)?.[1];
  assert.ok(windowProgram, 'candidate window jq program must stay testable');
  const pickWindow = makePickWindow(windowProgram, declaredWindow);
  // 빈 큐에서 죽지 않는다.
  assert.deepEqual(pickWindow(0, 0), []);
  for (const total of [declaredWindow + 1, declaredWindow * 2]) {
    const reachable = new Set();
    for (let offset = 0; offset < total; offset += 1) {
      const slice = pickWindow(total, offset);
      assert.ok(slice.length <= declaredWindow, `window exceeded at total=${total}`);
      assert.deepEqual(
        slice,
        [...slice].sort((a, b) => a - b),
        `candidate window must stay oldest-first at total=${total}`,
      );
      for (const index of slice) reachable.add(index);
    }
    assert.equal(
      reachable.size,
      total,
      `every candidate must be reachable from some offset at total=${total}`,
    );
  }
});

test('창은 실측 잔량에서 정해지고 예약분 아래로는 큐를 돌리지 않는다', async () => {
  const workflow = await readWorkflow();
  const budgetBlock = workflow.match(BUDGET_BLOCK_RE)?.[1];
  assert.ok(budgetBlock, 'candidate budget block must stay testable');

  // 잔량은 이 job이 실제로 쓰는 토큰에서 읽어야 한다. 한도값을 상수로 들고 있으면
  // 실행 빈도 가정으로 되돌아간 것과 같다.
  assert.ok(budgetBlock.includes('gh api rate_limit'), 'budget must be measured, not assumed');
  // 후보 평가는 REST와 GraphQL을 함께 쓴다. 한쪽만 보면 다른 버킷이 먼저 마른다.
  assert.ok(budgetBlock.includes('.resources.core.remaining'));
  assert.ok(budgetBlock.includes('.resources.graphql.remaining'));

  const windowMax = budgetConstantOf(workflow, 'window_max');
  const reserve = budgetConstantOf(workflow, 'reserve');
  const fixedCost = budgetConstantOf(workflow, 'fixed_cost');
  const perCandidate = budgetConstantOf(workflow, 'per_candidate');
  assert.equal(windowMax, 3);
  // 이 저장소에는 큐가 지켜 줘야 할 producer 체인이 없다. 예약분은 큐가 자기 다음 실행과
  // 운영자 조회 몫까지 태우지 않게 하는 하한이다. 실행당 고정 비용은 18회(ruleset 1 +
  // gh pr list 1 + 아래 fixed_cost 16)이고, 200회면 그 기준으로 11회 실행분(198회)이
  // 남는다. fixed_cost 16은 label marker, PR-visible fail-closed와 API 응답 변동을 위한 보수적 여유다.
  assert.equal(reserve, 200, 'shared-limit reserve must stay pinned');
  assert.equal(fixedCost, 16);
  // 후보당 청구는 호출 10회가 아니라 read_pages와 provenance 조회의 상한까지 덮는 값이다
  // (pr view 1 + reviewThreads 1 + REST PR 1 + REST 6종 * 3페이지 + actions-runs 3회). `--paginate`는 쓰지 않는다.
  assert.equal(perCandidate, 24, 'per-candidate charge must match the page-capped reads');

  // 응답 payload를 주고 워크플로의 jq 질의를 실제 jq로 적용해 `gh --jq`를 그대로 흉내낸다.
  const runBudget = (stub) =>
    spawnSync(
      'bash',
      [
        '-c',
        [
          'set -euo pipefail',
          `gh() { ${stub} }`,
          dedent(budgetBlock),
          `printf 'window=%s\\n' "$window"`,
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
  const runPayload = (payload) =>
    runBudget(`printf '%s' ${JSON.stringify(JSON.stringify(payload))} | jq -r "\${budget_query}";`);
  const buckets = (core, graphql) => ({
    resources: { core: { remaining: core }, graphql: { remaining: graphql } },
  });
  const windowAt = (remaining) => runPayload(buckets(remaining, remaining));

  // 기대값은 워크플로 상수로 되계산하지 않고 고정한다. 유도식을 바꾸는 것은 결정이므로
  // 테스트도 함께 고쳐야 한다.
  for (const [remaining, expected] of [
    [5000, 3],
    [1000, 3],
    [288, 3],
    [287, 2],
    [264, 2],
    [263, 1],
    [240, 1],
  ]) {
    const result = windowAt(remaining);
    assert.equal(result.status, 0, `budget block failed at remaining=${remaining}: ${result.stderr}`);
    assert.equal(
      result.stdout.trim(),
      `window=${expected}`,
      `window must follow the measured budget at remaining=${remaining}`,
    );
    // 핵심 불변식. 이번 실행이 계획한 지출을 다 써도 예약분은 남는다 — 큐가 공유 한도를
    // 바닥내 자기 다음 실행과 운영자 조회까지 막지 않는다.
    assert.ok(
      remaining - fixedCost - perCandidate * expected >= reserve,
      `queue must never plan to spend into the reserve at remaining=${remaining}`,
    );
    assert.ok(expected <= windowMax, `window must stay under the ceiling at remaining=${remaining}`);
  }

  // 두 버킷 값이 다르면 작은 쪽이 창을 정한다.
  assert.equal(runPayload(buckets(5000, 251)).stdout.trim(), 'window=1');
  assert.equal(runPayload(buckets(251, 5000)).stdout.trim(), 'window=1');

  // 예약분에 닿으면 큐만 건너뛴다. 실행을 실패시키지 않는다 — 실패로 남기면 그 check가
  // 다음 판정 입력을 오염시킨다.
  for (const remaining of [239, 220, 200, 0]) {
    const result = windowAt(remaining);
    assert.equal(result.status, 0, `budget block must not fail at remaining=${remaining}`);
    assert.match(result.stdout, /::warning::/, `low budget must be announced at remaining=${remaining}`);
    assert.doesNotMatch(
      result.stdout,
      /window=/,
      `queue must not run below the reserve at remaining=${remaining}`,
    );
  }

  // 잔량을 모르면 쓰지 않는다. 한쪽 버킷만 깨져도 마찬가지다.
  for (const [label, stub] of [
    ['core만 null', `printf '%s' ${JSON.stringify(JSON.stringify(buckets(null, 5000)))} | jq -r "\${budget_query}";`],
    ['graphql만 null', `printf '%s' ${JSON.stringify(JSON.stringify(buckets(5000, null)))} | jq -r "\${budget_query}";`],
    ['graphql 버킷 부재', `printf '%s' ${JSON.stringify(JSON.stringify({ resources: { core: { remaining: 5000 } } }))} | jq -r "\${budget_query}";`],
    ['core 값이 문자열', `printf '%s' ${JSON.stringify(JSON.stringify(buckets('5000', 5000)))} | jq -r "\${budget_query}";`],
    ['resources 부재', `printf '%s' '{}' | jq -r "\${budget_query}";`],
    ['빈 응답', "printf '';"],
    ['비숫자 응답', "printf '%s\\n' null;"],
    ['조회 실패', 'return 1;'],
  ]) {
    const result = runBudget(stub);
    assert.equal(result.status, 0, `budget block must not fail on ${label}`);
    assert.match(result.stdout, /::warning::/, `unknown budget must be announced on ${label}`);
    assert.doesNotMatch(result.stdout, /window=/, `queue must not run on ${label}`);
  }
});

test('후보 순회 중에도 잔량을 다시 읽어 예약분에서 멈춘다', async () => {
  const workflow = await readWorkflow();
  const queueLoop = workflow.match(
    /# queue-loop-begin\n([\s\S]*?)\n\s+# queue-loop-end/,
  )?.[1];
  assert.ok(queueLoop, 'queue loop must stay testable');
  const runQueue = makeRunQueue(queueLoop, budgetConstantsOf(workflow));

  // 재확인은 그 후보에 요청을 쓰기 전에 와야 한다. 뒤에 두면 이미 쓴 뒤에 멈춘다.
  const recheck = workflow.match(
    /# budget-recheck-begin\n([\s\S]*?)\n\s+# budget-recheck-end/,
  )?.[1];
  assert.ok(recheck, 'budget recheck block must stay testable');
  assert.ok(recheck.includes('gh api rate_limit'), 'recheck must re-measure, not reuse the draw');
  const recheckAt = workflow.indexOf('# budget-recheck-begin');
  const firstViewAt = workflow.indexOf('info="$(gh pr view');
  assert.ok(recheckAt > 0 && firstViewAt > recheckAt, 'recheck must precede the candidate request');

  const queue = [
    { number: 1, mergeStateStatus: 'BLOCKED' },
    { number: 2, mergeStateStatus: 'BLOCKED' },
    { number: 3, mergeStateStatus: 'CLEAN' },
  ];

  // 잔량이 충분하면 셋 다 평가하고 마지막 후보를 병합한다.
  const plenty = runQueue(queue, { remaining: [5000] });
  assert.equal(plenty.status, 0);
  assert.deepEqual(plenty.evaluated, [1, 2, 3]);
  assert.equal(plenty.mergedPr, 3);
  // 창 산출 1회 + 후보 3건 재확인 3회.
  assert.equal(plenty.rateCalls, 4, 'budget must be re-measured once per candidate');

  // 창을 정할 때는 넉넉했는데 순회 중 예약분에 닿으면, 첫 후보에 요청을 쓰기 전에 멈춘다.
  const drained = runQueue(queue, { remaining: [5000, 220] });
  assert.equal(drained.status, 0, 'reserve stop must not fail the run');
  assert.deepEqual(drained.evaluated, [], 'no candidate may be evaluated below the reserve');
  assert.equal(drained.mergedPr, null);
  assert.match(drained.stdout + drained.stderr, /::warning::/);

  // 한 건을 평가한 뒤 바닥나면 거기서 멈춘다. 뒤의 병합 가능 후보는 다음 실행 몫이다.
  const midway = runQueue(queue, { remaining: [5000, 5000, 220] });
  assert.equal(midway.status, 0);
  assert.deepEqual(midway.evaluated, [1], 'evaluation must stop at the reserve boundary');
  assert.equal(midway.mergedPr, null);

  // 순회 중 잔량을 못 읽는 것도 소진과 같게 다룬다.
  const unknown = runQueue(queue, { remaining: [5000, 'null'] });
  assert.equal(unknown.status, 0, 'unknown budget must not fail the run');
  assert.deepEqual(unknown.evaluated, []);
  assert.match(unknown.stdout + unknown.stderr, /::warning::/);
});

test('창 시작점은 실행 컨텍스트를 읽지 않고 실행마다 새로 뽑힌다', async () => {
  const workflow = await readWorkflow();
  const declaredWindow = declaredWindowOf(workflow);

  // 커버리지 보장이 실행 간격에 의존하지 않으려면 시작점이 실행 컨텍스트 값의 함수가
  // 아니어야 한다.
  const offsetBlock = workflow.match(
    /# candidate-offset-begin\n([\s\S]*?)\n\s+# candidate-offset-end/,
  )?.[1];
  assert.ok(offsetBlock, 'candidate offset block must stay testable');
  assert.doesNotMatch(
    offsetBlock,
    /GITHUB_RUN_NUMBER|GITHUB_RUN_ID|GITHUB_RUN_ATTEMPT|GITHUB_SHA|GITHUB_EVENT/,
    'candidate offset must not depend on run context',
  );

  const drawOffset = (total, runNumber) => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -euo pipefail',
          `GITHUB_RUN_NUMBER=${JSON.stringify(String(runNumber))}`,
          // 창 크기는 앞선 예산 블록이 정한다. 여기서는 주입값으로 시작점만 본다.
          `window=${declaredWindow}`,
          `candidates=${JSON.stringify(
            JSON.stringify(Array.from({ length: total }, (_, index) => index)),
          )}`,
          dedent(offsetBlock),
          `printf '%s %s\\n' "$window" "$offset"`,
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `offset block failed: ${result.stderr}`);
    const [drawnWindow, offset] = result.stdout.trim().split(' ').map(Number);
    assert.equal(drawnWindow, declaredWindow, 'offset draw must not resize the window');
    return offset;
  };

  // 창 안에 다 들어오면 회전하지 않는다. 빈 큐에서도 죽지 않는다.
  for (const total of [0, 1, declaredWindow]) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal(drawOffset(total, attempt), 0, `must not rotate at total=${total}`);
    }
  }

  // total > window면 시작점이 실행마다 새로 뽑히고 범위 안에 있다. run number를 고정해
  // 두는 것은 최악의 앨리어싱 입력(간격 0)이며, 그래도 성질이 유지되어야 한다.
  const rotationTotal = 2 * declaredWindow;
  const samples = 64;
  const drawn = [];
  for (let attempt = 0; attempt < samples; attempt += 1) {
    drawn.push(drawOffset(rotationTotal, 7));
  }
  for (const offset of drawn) {
    assert.ok(
      Number.isInteger(offset) && offset >= 0 && offset < rotationTotal,
      `offset out of range: ${offset}`,
    );
  }
  assert.ok(
    new Set(drawn).size > 1,
    'candidate offset must vary across executions even with a fixed run number',
  );
  // 뽑힌 시작점들의 창 합집합이 전 후보를 덮는다. 표본 성질이라 실패 확률이 0은 아니지만,
  // 후보 하나가 한 표본에서 빠질 확률이 1 - window/total = 1/2이므로 64회에서 누락
  // 확률은 total * 2^-64 수준이다.
  const windowProgram = workflow.match(WINDOW_PROGRAM_RE)?.[1];
  assert.ok(windowProgram, 'candidate window jq program must stay testable');
  const pickWindow = makePickWindow(windowProgram, declaredWindow);
  const covered = new Set();
  for (const offset of drawn) {
    for (const index of pickWindow(rotationTotal, offset)) covered.add(index);
  }
  assert.equal(covered.size, rotationTotal, 'drawn offsets must cover the whole queue');
});

test('창 밖 후보 도달 가능성은 시작점을 주입해 결정적으로 고정한다', async () => {
  const workflow = await readWorkflow();
  const declaredWindow = declaredWindowOf(workflow);
  const queueLoop = workflow.match(
    /# queue-loop-begin\n([\s\S]*?)\n\s+# queue-loop-end/,
  )?.[1];
  assert.ok(queueLoop, 'queue loop must stay testable');
  const runQueue = makeRunQueue(queueLoop, budgetConstantsOf(workflow));
  // 시작점 산출을 뺀 뒷부분만 뽑는다. 큐 루프 전체를 쓰면 주입한 값을 난수 draw가 덮어써
  // 이 테스트가 다시 표본이 된다.
  const candidateLoop = workflow.match(
    /# candidate-offset-end\n([\s\S]*?)\n\s+# queue-loop-end/,
  )?.[1];
  assert.ok(candidateLoop, 'candidate loop must stay testable');
  assert.doesNotMatch(
    candidateLoop,
    /RANDOM/,
    'injected offsets must not be overwritten by the draw',
  );
  const runCandidateLoop = makeRunQueue(candidateLoop, budgetConstantsOf(workflow));
  const windowProgram = workflow.match(WINDOW_PROGRAM_RE)?.[1];
  assert.ok(windowProgram, 'candidate window jq program must stay testable');
  const pickWindow = makePickWindow(windowProgram, declaredWindow);

  // 굶주림 제거는 두 성질의 곱이고, 둘은 성격이 달라 따로 고정해야 한다.
  //   ① 도달 가능성(결정적): 어떤 시작점에서 그 후보가 실제로 평가되고 병합되는가.
  //   ② 시작점 분포(표본·구조): 위 '창 시작점은 …' 테스트가 담당한다.
  const rotationTotal = 2 * declaredWindow;
  const aliasingQueue = [];
  for (let number = 1; number < rotationTotal; number += 1) {
    aliasingQueue.push({ number, mergeStateStatus: 'CLEAN', state: 'CLOSED' });
  }
  aliasingQueue.push({ number: rotationTotal, mergeStateStatus: 'CLEAN' });

  const mergedFrom = [];
  for (let offset = 0; offset < rotationTotal; offset += 1) {
    const run = runCandidateLoop(aliasingQueue, { window: declaredWindow, offset });
    assert.equal(run.status, 0, `offset=${offset}에서 실행이 실패했다: ${run.stderr}`);
    if (run.mergedPr === rotationTotal) mergedFrom.push(offset);
  }

  // 그 후보를 병합하는 시작점이 하나라도 있어야 한다. 창을 큐 앞쪽에 고정하면 여기가 빈다.
  assert.ok(
    mergedFrom.length > 0,
    'the only mergeable candidate sits past the window and must be reachable from some offset',
  );
  // 창 선택과 루프 동작이 일치해야 한다.
  const windowContains = [];
  for (let offset = 0; offset < rotationTotal; offset += 1) {
    if (pickWindow(rotationTotal, offset).includes(rotationTotal - 1)) windowContains.push(offset);
  }
  assert.deepEqual(
    mergedFrom,
    windowContains,
    'the offsets that merge the late candidate must be exactly the offsets whose window contains it',
  );
  assert.equal(
    mergedFrom.length,
    declaredWindow,
    'reachable offsets must equal the window size (probability = window / total)',
  );

  // 후보가 창 안에 다 들어오면 시작점 산출이 회전하지 않으므로, 실행 번호와 무관하게
  // 오래된 후보가 먼저 병합된다.
  for (const runNumber of [0, 7, 40]) {
    assert.equal(
      runQueue(
        [
          { number: 1, mergeStateStatus: 'CLEAN' },
          { number: 2, mergeStateStatus: 'CLEAN' },
        ],
        { runNumber },
      ).mergedPr,
      1,
    );
  }
});

test('draft 필터는 창 산출 이전에 적용된다', async () => {
  const workflow = await readWorkflow();
  const declaredWindow = declaredWindowOf(workflow);

  // 순서 계약. draft 필터가 창 뒤로 밀리면 draft가 창 자리를 차지해 실제로 평가되는
  // 후보 수가 window보다 줄어든다.
  const candidatesAt = workflow.indexOf('candidates="$(gh pr list');
  const budgetAt = workflow.indexOf('# candidate-budget-begin');
  const offsetAt = workflow.indexOf('# candidate-offset-begin');
  const windowAt = workflow.indexOf('# candidate-window-begin');
  assert.ok(candidatesAt > 0, 'candidate selection must stay findable');
  assert.ok(budgetAt > candidatesAt, 'draft filter must run before the budget draw');
  assert.ok(offsetAt > budgetAt, 'window size must be settled before the offset draw');
  assert.ok(windowAt > offsetAt, 'draft filter must run before the window slice');

  const selectProgram = workflow.match(
    /--jq '(\[\.\[\] \| select\(\.isDraft == false\)\] \| \[sort_by\(\.createdAt\)\[\]\.number\])'/,
  )?.[1];
  assert.ok(selectProgram, 'candidate selection jq program must stay testable');

  // draft가 섞인 목록. non-draft만 오래된 순으로 남아야 한다.
  const raw = [];
  for (let index = 0; index < declaredWindow * 2; index += 1) {
    raw.push({
      number: index + 1,
      createdAt: `2026-08-01T00:${String(index).padStart(2, '0')}:00Z`,
      isDraft: index % 2 === 1,
    });
  }
  const selected = spawnSync('jq', ['-c', selectProgram], {
    input: JSON.stringify(raw),
    encoding: 'utf8',
  }).stdout.trim();
  const expected = raw.filter((pr) => !pr.isDraft).map((pr) => pr.number);
  assert.equal(selected, JSON.stringify(expected));

  // 걸러진 목록을 그대로 시작점 산출에 넣는다.
  const offsetBlock = workflow.match(
    /# candidate-offset-begin\n([\s\S]*?)\n\s+# candidate-offset-end/,
  )?.[1];
  assert.ok(offsetBlock, 'candidate offset block must stay testable');
  assert.ok(
    offsetBlock.includes('<<<"${candidates}"'),
    'offset draw must read the draft-filtered candidate list',
  );
  const drawn = spawnSync(
    'bash',
    [
      '-c',
      [
        'set -euo pipefail',
        `window=${declaredWindow}`,
        `candidates=${JSON.stringify(selected)}`,
        dedent(offsetBlock),
        `printf '%s %s\\n' "$total" "$offset"`,
      ].join('\n'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(drawn.status, 0, drawn.stderr);
  assert.equal(drawn.stdout.trim(), `${expected.length} 0`);
});


// `run: |` 본문은 YAML block scalar다. 안쪽 줄 하나가 블록 들여쓰기 아래로 내려가면
// 블록은 거기서 끝나고 나머지 스크립트가 YAML 구조로 새어 나간다. 문자열 포함 검사만
// 하는 계약 테스트는 그 파손을 그대로 통과시키므로 구조 자체를 계약으로 고정한다.
const runBlocks = (workflow) => {
  const lines = workflow.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opener = /^(\s*)run: \|\s*$/.exec(lines[index]);
    if (!opener) continue;
    const keyIndent = opener[1].length;
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1;
    const blockIndent = /^\s*/.exec(lines[cursor] ?? '')[0].length;
    const body = [];
    let terminator = null;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === '') {
        body.push('');
        continue;
      }
      if (/^\s*/.exec(line)[0].length < blockIndent) {
        terminator = { line, number: cursor + 1 };
        break;
      }
      body.push(line.slice(blockIndent));
    }
    blocks.push({ keyIndent, blockIndent, body: body.join('\n'), terminator, openedAt: index + 1 });
  }
  return blocks;
};

const workflowFiles = async () => {
  // GitHub Actions는 .yml과 .yaml을 모두 워크플로로 읽는다. 한쪽만 보면 block scalar
  // 계약과 push 트리거 계약이 함께 헐거워진다.
  const names = (await readdir(workflowsDirUrl))
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  assert.ok(names.length > 0, '워크플로 디렉터리가 비었다');
  return Promise.all(
    names.map(async (name) => [name, await readFile(new URL(name, workflowsDirUrl), 'utf8')]),
  );
};

test('워크플로 run 블록은 YAML block scalar 들여쓰기를 지킨다', async () => {
  const files = await workflowFiles();
  let checkedBlocks = 0;

  for (const [name, workflow] of files) {
    const blocks = runBlocks(workflow);

    for (const block of blocks) {
      checkedBlocks += 1;
      assert.ok(
        block.blockIndent > block.keyIndent,
        `${name}:${block.openedAt}: block scalar 본문이 run 키보다 깊게 들여쓰기되어야 한다`,
      );
      // 블록을 끝내는 줄은 반드시 더 얕은 레벨의 정상 YAML 키여야 한다. 스크립트 본문이
      // 흘러넘친 줄이면 여기서 걸린다.
      if (block.terminator) {
        assert.match(
          block.terminator.line,
          /^ *(- )?[A-Za-z_][A-Za-z0-9_.-]*:(\s|$)/,
          `${name}:${block.terminator.number}: block scalar 밖으로 새어 나온 줄 — ${JSON.stringify(block.terminator.line)}`,
        );
      }
      // 구조가 살아 있어도 내용이 잘리면 셸이 깨진다. 두 겹으로 잡는다.
      const syntax = spawnSync('bash', ['-n'], { input: block.body, encoding: 'utf8' });
      assert.equal(
        syntax.status,
        0,
        `${name}:${block.openedAt}: run 블록이 bash 문법 검사에 실패했다 — ${syntax.stderr}`,
      );
    }
  }

  assert.ok(checkedBlocks > 0, '검사할 workflow run 블록이 하나도 없다');
});

test('여러 줄 셸 문자열은 한 줄 안에서 닫힌다', async () => {
  // 형제 저장소에서 코멘트 본문을 여러 줄로 쓴 `--body "` 가 block scalar를 깨뜨렸다.
  const workflow = await readWorkflow();
  assert.doesNotMatch(workflow, /--body "[^"\n]*$/m);
});

test('CI는 실제 YAML 파서로 워크플로를 검사한다', async () => {
  const ciWorkflow = await readFile(ciWorkflowUrl, 'utf8');
  assert.ok(ciWorkflow.includes('rhysd/actionlint@sha256:'));
  assert.match(ciWorkflow, /docker run --rm[\s\S]{0,200}rhysd\/actionlint@sha256:[a-f0-9]{64}/);
  // 이 계약 테스트 자체가 CI에서 실행되어야 한다.
  assert.match(ciWorkflow, /tools\/ci\/automerge-queue\.test\.mjs/);
});

test('코디네이터는 main push CI를 되살리지 않는다', async () => {
  const workflow = await readWorkflow();

  // GITHUB_TOKEN 병합은 push 이벤트를 만들지 못하므로 main push CI 실행이 사라진다. 이
  // 억제를 되살릴지는 저장소 하나가 혼자 정할 문제가 아니다 — 형제 저장소(backend·mobile)
  // coordinator도 main CI를 dispatch하지 않고, 코디네이터가 병합한 SHA에 main push CI
  // 실행이 0건인 것을 실측했다. 네 저장소의 병합 경로를 일치시키기 위해 억제를 수용한다.
  const dispatches = [...workflow.matchAll(/gh workflow run ([^\s]+)[^\n]*--ref ([^\s"']+|"[^"]+")/g)]
    .map((match) => `${match[1]} ${match[2]}`);
  assert.deepEqual(dispatches, ['ci.yml "${head_ref}"']);
  for (const basis of [
    'main push 실행도 되살리지 않는다',
    'mergedBy가',
    'strict required status checks',
  ]) {
    assert.ok(workflow.includes(basis), `main CI 억제 근거 누락: ${basis}`);
  }
});

test('required context 부재 복구용 CI dispatch가 성립한다', async () => {
  const ciWorkflow = await readFile(ciWorkflowUrl, 'utf8');

  // same-repository head에 required context가 없을 때 붙이는 경로가 dispatch다.
  assert.ok(ciWorkflow.includes('  workflow_dispatch:'));
  // dispatch 실행도 required context와 같은 이름의 check를 만들어야 한다.
  assert.match(ciWorkflow, /^ {4}name: Platform CI$/m);
  // 이벤트에 따라 job이 갈리면 dispatch 실행이 다른 check 집합을 만든다.
  assert.doesNotMatch(ciWorkflow, /github\.event_name/);
});

test('병합 후 dispatch가 필요한 producer가 없다는 전제를 고정한다', async () => {
  // 이 저장소에는 병합 push로만 시작되는 producer가 없어 코디네이터가 잇는 체인이 PR CI
  // 하나뿐이다(2026-08-02 실측). 그 전제가 깨지면 GITHUB_TOKEN 병합이 새 워크플로를
  // 조용히 끊으므로, push 트리거가 늘어나는 순간 이 테스트가 실패해 판정을 다시 하게 한다.
  const files = await workflowFiles();
  const pushTriggered = files
    .filter(([, workflow]) => {
      const triggers = workflow.slice(
        workflow.indexOf('\non:'),
        workflow.indexOf('\njobs:'),
      );
      return /^ {2}push:$/m.test(triggers);
    })
    .map(([name]) => name);
  assert.deepEqual(
    pushTriggered,
    ['automerge-queue.yml', 'ci.yml'],
    'push 트리거 워크플로가 늘었다면 병합 후 명시 dispatch가 필요한지 다시 판정해야 한다',
  );

  // 코디네이터가 만드는 명시 dispatch는 required context 부재 복구용 PR CI 하나뿐이어야
  // 한다. producer dispatch를 몰래 늘리면 판정 근거(위 실측)와 어긋난다.
  const workflow = await readWorkflow();
  const dispatches = [...workflow.matchAll(/gh workflow run ([^\s]+)/g)].map((match) => match[1]);
  assert.deepEqual(dispatches, ['ci.yml']);
  // 판정 근거는 주석으로 남아 있어야 한다. 근거 없이 값만 남으면 다음 사람이 되돌린다.
  for (const basis of ['cd.yml', 'sensitive-backup-retention.yml', '병합 후 실행되어야 하는 producer는 없다']) {
    assert.ok(workflow.includes(basis), `producer 판정 근거 누락: ${basis}`);
  }
});

// ---------------------------------------------------------------------------
// BEHIND 자동 갱신과 marker 재발행·복구 (backend #412 이식, platform #207)
// ---------------------------------------------------------------------------
const markerFor = (head) => `<!-- Automerge frozen discovery authorization: ${head} -->`;
const recordFor = (head) => `<!-- Automerge base update requested: ${head} -->`;
const actionsBotUser = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' };
const interrogateMarkerFor = (sha, actOn = 0) =>
  `<!-- pstack-interrogate head=${sha} act-on=${actOn} -->`;
const interrogateDiscoveryBody = (sha, actOn = 0) =>
  `## Summary\n\nNo blocking findings.\n\n${interrogateMarkerFor(sha, actOn)}`;
const discoveryReview = (commitId, overrides = {}) => ({
  id: 5,
  state: 'COMMENTED',
  submitted_at: '2026-09-29T00:00:00Z',
  commit_id: commitId,
  author_association: 'OWNER',
  body: interrogateDiscoveryBody(commitId),
  user: { login: 'reviewer', type: 'User' },
  ...overrides,
});
const committedAt = (sha, date) => ({ sha, commit: { committer: { date } } });
const labeledAt = (date, name = 'automerge') => ({ event: 'labeled', label: { name }, created_at: date });

// 워크플로의 marker 동기화 블록을 그대로 꺼내 stub gh로 실행한다. comments·reviews·commits는
// read_pages가 돌려주는 모양(페이지 배열)이다. stub은 `--jq`를 실제 jq로 적용하고 토큰을 남긴다.
const runMarkerSync = (
  workflow,
  { head, comments = [], reviews = [], commits = [], headCommit = null, compare = null, events = null, mutation = 'ok' },
) => {
  const block = workflow.match(MARKER_SYNC_RE)?.[1];
  assert.ok(block, 'authorization marker sync must stay testable');
  const dir = mkdtempSync(join(tmpdir(), 'automerge-marker-sync-'));
  const log = join(dir, 'gh.log');
  const fixture = (name, payload) =>
    writeFileSync(join(dir, name), payload === '__FAIL__' ? payload : JSON.stringify(payload));
  if (headCommit !== null) fixture('head-commit.json', headCommit);
  if (compare !== null) fixture('compare.json', compare);
  (events ?? []).forEach((page, index) => fixture(`events-${index + 1}.json`, page));
  const result = spawnSync('bash', ['-c', [
    'set -euo pipefail',
    `GH_LOG=${JSON.stringify(log)}`,
    `FIX=${JSON.stringify(dir)}`,
    'repo=o/r',
    'pr=85',
    `head=${JSON.stringify(head)}`,
    'GH_TOKEN=github-token',
    'MERGE_GH_TOKEN=merge-token',
    `mutation=${JSON.stringify(mutation)}`,
    `comments=${JSON.stringify(JSON.stringify([comments]))}`,
    `reviews=${JSON.stringify(JSON.stringify([reviews]))}`,
    `commits=${JSON.stringify(JSON.stringify([commits]))}`,
    ': > "$GH_LOG"',
    'gh() {',
    '  printf "TOKEN=%s gh %s\\n" "$GH_TOKEN" "$*" >> "$GH_LOG"',
    '  local all="$*" filter="" previous="" argument payload="" page',
    '  for argument in "$@"; do [[ "$previous" == --jq ]] && filter="$argument"; previous="$argument"; done',
    '  case "$all" in',
    '    "api --method PATCH repos/o/r/issues/comments/"*|"api --method POST repos/o/r/issues/"*"/comments "*)',
    '      [[ "$mutation" == fail ]] && return 1',
    '      local id=77; [[ "$all" == *"issues/comments/"* ]] && { id="${all#*issues/comments/}"; id="${id%% *}"; }',
    '      if [[ "$mutation" == foreign ]]; then',
    '        jq -nc --argjson id "$id" \'{id: $id, body: "other", user: {login: "github-actions[bot]", id: 41898282, type: "Bot"}}\'',
    '        return 0',
    '      fi',
    '      jq -nc --argjson id "$id" --arg body "${all#*body=}" \'{id: $id, body: $body, user: {login: "github-actions[bot]", id: 41898282, type: "Bot"}}\' ;;',
    '    "api repos/o/r/commits/"*) payload="$(cat "$FIX/head-commit.json" 2>/dev/null || printf __FAIL__)" ;;',
    '    "api repos/o/r/compare/"*) payload="$(cat "$FIX/compare.json" 2>/dev/null || printf __FAIL__)" ;;',
    '    "api repos/o/r/issues/85/events?per_page=100&page="*) page="${all##*page=}"; payload="$(cat "$FIX/events-$page.json" 2>/dev/null || printf __FAIL__)" ;;',
    '    *) printf "unstubbed gh call: %s\\n" "$all" >&2; return 1 ;;',
    '  esac',
    '  if [[ -n "$payload" ]]; then',
    '    [[ "$payload" == __FAIL__ ]] && return 1',
    '    if [[ -n "$filter" ]]; then jq -r "$filter" <<<"$payload"; else printf "%s\\n" "$payload"; fi',
    '  fi',
    '}',
    dedent(block),
    'sync_authorization_marker',
    'printf "SYNC_RETURNED\\n"',
    'printf "%s\\n" "$comments"',
  ].join('\n')], { encoding: 'utf8' });
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const lines = (result.stdout ?? '').trim().split('\n');
  const after = lines.at(-1)?.startsWith('[') ? JSON.parse(lines.at(-1)).flat() : [];
  const canonical = after.filter(
    (comment) =>
      comment.user?.login === actionsBotUser.login &&
      comment.user?.id === actionsBotUser.id &&
      comment.user?.type === actionsBotUser.type &&
      /^<!-- Automerge frozen discovery authorization: [0-9a-f]{40} -->$/.test(comment.body ?? ''),
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls,
    mutations: calls.split('\n').filter((line) => / --method (PATCH|POST) /.test(line)),
    authorized: canonical.length === 1 && canonical[0].body === markerFor(head),
  };
};

test('marker 재발행은 코디네이터 기록이 있는 base 갱신 병합 커밋에만 적용된다', async () => {
  const workflow = await readWorkflow();
  const previous = 'b'.repeat(40);
  const head = 'c'.repeat(40);
  const mainParent = 'd'.repeat(40);
  const other = 'e'.repeat(40);
  const markerComment = { id: 99, body: markerFor(previous), user: actionsBotUser };
  const record = { id: 100, body: recordFor(previous), user: actionsBotUser };
  const base = {
    head,
    comments: [markerComment, record],
    reviews: [discoveryReview(previous)],
    commits: [{ sha: previous }, { sha: head }],
    headCommit: { sha: head, parents: [{ sha: previous }, { sha: mainParent }] },
    compare: { status: 'ahead' },
  };

  for (const status of ['ahead', 'identical']) {
    const reissued = runMarkerSync(workflow, { ...base, compare: { status } });
    assert.equal(reissued.status, 0, reissued.stderr);
    assert.deepEqual(
      reissued.mutations,
      [`TOKEN=github-token gh api --method PATCH repos/o/r/issues/comments/99 -f body=${markerFor(head)}`],
    );
    assert.match(reissued.calls, new RegExp(`gh api repos/o/r/compare/${mainParent}\\.\\.\\.main `));
    assert.equal(reissued.authorized, true, 'the patched marker must replace the old one in the gate input');
  }

  for (const [label, options] of [
    ['first parent differs from the marker head', { headCommit: { sha: head, parents: [{ sha: other }, { sha: mainParent }] } }],
    ['single-parent session push', { headCommit: { sha: head, parents: [{ sha: previous }] } }],
    ['octopus merge', { headCommit: { sha: head, parents: [{ sha: previous }, { sha: mainParent }, { sha: other }] } }],
    ['malformed parent', { headCommit: { sha: head, parents: [{ sha: previous }, { sha: 'not-a-sha' }] } }],
    ['second parent behind main', { compare: { status: 'behind' } }],
    ['second parent diverged from main', { compare: { status: 'diverged' } }],
    ['commit lookup failure', { headCommit: '__FAIL__' }],
    ['compare lookup failure', { compare: '__FAIL__' }],
  ]) {
    const kept = runMarkerSync(workflow, { ...base, ...options });
    assert.equal(kept.status, 0, `${label}: ${kept.stderr}`);
    assert.match(kept.stdout, /SYNC_RETURNED/);
    assert.deepEqual(kept.mutations, [], `${label} must not reissue`);
    assert.equal(kept.authorized, false);
  }

  for (const [label, comments] of [
    ['no base-update record', [markerComment]],
    ['record for another head', [markerComment, { ...record, body: recordFor(other) }]],
    ['forged record author', [markerComment, { ...record, user: { ...actionsBotUser, id: 1 } }]],
    ['duplicated records', [markerComment, record, { ...record, id: 101 }]],
    ['accumulated canonical markers', [markerComment, { ...markerComment, id: 98, body: markerFor(other) }, record]],
  ]) {
    const kept = runMarkerSync(workflow, { ...base, comments });
    assert.equal(kept.status, 0, `${label}: ${kept.stderr}`);
    assert.equal(kept.calls, '', `${label} must not reissue or look up anything`);
    assert.equal(kept.authorized, false);
  }

  const current = runMarkerSync(workflow, { ...base, comments: [{ ...markerComment, body: markerFor(head) }] });
  assert.equal(current.calls, '', 'an exact-head marker needs no API call');
  assert.equal(current.authorized, true);

  for (const mutation of ['fail', 'foreign']) {
    const failed = runMarkerSync(workflow, { ...base, mutation });
    assert.equal(failed.status, 0, `${mutation}: ${failed.stderr}`);
    assert.equal(failed.mutations.length, 1, `${mutation} must not retry`);
    assert.equal(failed.authorized, false);
    assert.match(failed.stdout, /::warning::PR #85: authorization marker/);
    assert.doesNotMatch(failed.stdout, /now covers/);
  }
});

test('marker 복구는 marker가 없고 게이트 정의의 discovery가 있으며 라벨 시점 이전 head일 때만 게시한다', async () => {
  const workflow = await readWorkflow();
  const previous = 'b'.repeat(40);
  const head = 'c'.repeat(40);
  const outside = 'f'.repeat(40);
  const base = {
    head,
    comments: [],
    reviews: [discoveryReview(head)],
    commits: [committedAt(previous, '2026-09-29T00:00:00Z'), committedAt(head, '2026-09-29T01:00:00Z')],
    events: [[labeledAt('2026-09-29T02:00:00Z')]],
  };
  const codeRabbit = {
    author_association: 'NONE',
    body: '',
    user: { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' },
  };
  const posted = [`TOKEN=github-token gh api --method POST repos/o/r/issues/85/comments -f body=${markerFor(head)}`];
  const hundred = (event) => Array.from({ length: 100 }, () => event);

  for (const [label, options] of [
    ['pstack-interrogate discovery on the current head', {}],
    ['trusted approval on the current head', { reviews: [discoveryReview(head, { state: 'APPROVED', body: '' })] }],
    ['CodeRabbit discovery on the current head', { reviews: [discoveryReview(head, codeRabbit)] }],
    ['CodeRabbit discovery on an earlier PR commit', { reviews: [discoveryReview(previous, codeRabbit)] }],
    ['spoofed marker is not canonical', { comments: [{ id: 7, body: markerFor(previous), user: { ...actionsBotUser, id: 1 } }] }],
    ['head committed at the label time', { events: [[labeledAt('2026-09-29T01:00:00Z')]] }],
    ['relabel after the head', { events: [[labeledAt('2026-09-28T00:00:00Z'), labeledAt('2026-09-29T02:00:00Z')]] }],
    ['force push before the label', { events: [[{ event: 'head_ref_force_pushed', created_at: '2026-09-29T01:30:00Z' }, labeledAt('2026-09-29T02:00:00Z')]] }],
    ['a full first page followed by an empty page', { events: [hundred(labeledAt('2026-09-29T02:00:00Z')), []] }],
  ]) {
    const recovered = runMarkerSync(workflow, { ...base, ...options });
    assert.equal(recovered.status, 0, `${label}: ${recovered.stderr}`);
    assert.deepEqual(recovered.mutations, posted, `${label} must recover the labeled head`);
    assert.equal(recovered.authorized, true, `${label} must authorize the current head in this run`);
  }

  for (const [label, options] of [
    ['no review', { reviews: [] }],
    ['approval on an earlier commit', { reviews: [discoveryReview(previous, { state: 'APPROVED', body: '' })] }],
    ['pstack-interrogate discovery on an earlier PR commit', { reviews: [discoveryReview(previous)] }],
    ['pstack-interrogate discovery with act-on > 0', { reviews: [discoveryReview(head, { body: interrogateDiscoveryBody(head, 1) })] }],
    ['pstack-interrogate discovery with duplicate markers', { reviews: [discoveryReview(head, { body: `${interrogateMarkerFor(head, 0)}\n${interrogateMarkerFor(head, 0)}` })] }],
    ['pstack-interrogate discovery with mismatched marker head', { reviews: [discoveryReview(head, { body: interrogateDiscoveryBody(previous, 0) })] }],
    ['open CHANGES_REQUESTED alongside CodeRabbit', { reviews: [discoveryReview(head, codeRabbit), discoveryReview(previous, { id: 6, state: 'CHANGES_REQUESTED', body: '', user: { login: 'reviewer-two', type: 'User' } })] }],
    ['open ACT_ON review alongside CodeRabbit', { reviews: [discoveryReview(head, codeRabbit), discoveryReview(head, { id: 6, body: interrogateDiscoveryBody(head, 1), user: { login: 'reviewer-two', type: 'User' } })] }],
    ['dismissed approval followed by plain comment', { reviews: [discoveryReview(head, { state: 'APPROVED', body: '' }), discoveryReview(head, { id: 6, state: 'DISMISSED', submitted_at: '2026-09-29T00:01:00Z', body: '' }), discoveryReview(head, { id: 7, submitted_at: '2026-09-29T00:02:00Z', body: 'nit', user: { login: 'reviewer-two', type: 'User' } })] }],
    ['collaborator Bot identity', { reviews: [discoveryReview(head, { author_association: 'COLLABORATOR', user: { login: 'helper[bot]', type: 'Bot' } })] }],
    ['retired Aquila Universal Review marker', { reviews: [discoveryReview(head, { body: '**Actionable comments posted: 0**\n<!-- Review source: Aquila Universal Review; engine: aquila-review -->' })] }],
    ['retired Aquila fallback marker', { reviews: [discoveryReview(head, { body: '**Actionable comments posted: 0**\n<!-- Review source: Aquila fallback; canonical visible structure: PR #1926 Review 4676157515 -->' })] }],
    ['retired Codex CLI fallback marker', { reviews: [discoveryReview(head, { body: '**Actionable comments posted: 0**\n<!-- Review source: Codex CLI fallback; canonical visible structure: PR #1926 Review 4676157515 -->' })] }],
    ['non-canonical comment review', { reviews: [discoveryReview(head, { body: 'looks fine' })] }],
    ['discovery outside the PR commit set', { reviews: [discoveryReview(outside, codeRabbit)] }],
    ['untrusted author association', { reviews: [discoveryReview(head, { author_association: 'NONE' })] }],
    ['CodeRabbit impersonation', { reviews: [discoveryReview(head, { ...codeRabbit, user: { ...codeRabbit.user, id: 1 } })] }],
  ]) {
    const kept = runMarkerSync(workflow, { ...base, ...options });
    assert.equal(kept.status, 0, `${label}: ${kept.stderr}`);
    assert.equal(kept.calls, '', `${label} must not read events or post a marker`);
    assert.equal(kept.authorized, false);
  }

  for (const [label, options] of [
    ['head committed after the latest automerge label', { commits: [committedAt(previous, '2026-09-29T00:00:00Z'), committedAt(head, '2026-09-29T03:00:00Z')] }],
    ['events lookup failure', { events: ['__FAIL__'] }],
    ['no events at all', { events: [[]] }],
    ['only other label events', { events: [[labeledAt('2026-09-29T02:00:00Z', 'ready')]] }],
    ['force push after the label', { events: [[labeledAt('2026-09-29T02:00:00Z'), { event: 'head_ref_force_pushed', created_at: '2026-09-29T02:30:00Z' }]] }],
    ['unparseable label time', { events: [[labeledAt('yesterday')]] }],
    ['head without a committer date', { commits: [committedAt(previous, '2026-09-29T00:00:00Z'), { sha: head }] }],
    ['event history beyond the bounded read', { events: [hundred(labeledAt('2026-09-29T02:00:00Z')), [labeledAt('2026-09-29T02:00:00Z')]] }],
  ]) {
    const kept = runMarkerSync(workflow, { ...base, ...options });
    assert.equal(kept.status, 0, `${label}: ${kept.stderr}`);
    assert.match(kept.stdout, /SYNC_RETURNED/);
    assert.deepEqual(kept.mutations, [], `${label} must not recover a marker`);
    assert.equal(kept.authorized, false);
  }

  const failed = runMarkerSync(workflow, { ...base, mutation: 'fail' });
  assert.equal(failed.mutations.length, 1);
  assert.equal(failed.authorized, false, 'a failed recovery must not authorize the head');
});

test('marker 동기화와 BEHIND 승계 판정은 리뷰 게이트와 같은 review_jq_defs를 공유하고 Dependabot 예외 경로에서는 돌지 않는다', async () => {
  const workflow = await readWorkflow();
  const reviewJqDefs = workflow.match(REVIEW_JQ_DEFS_RE)?.[1];
  assert.ok(reviewJqDefs, 'shared review_jq_defs must exist');
  const sync = workflow.match(MARKER_SYNC_RE)?.[1];
  assert.ok(sync, 'authorization marker sync must stay testable');
  const gate = workflow.match(
    /# review-state-filter-begin\n[\s\S]*?if ! jq -s -e --arg head "\$\{head\}" "\$\{review_jq_defs\}"'\n([\s\S]*?)\n\s+' \\\n/,
  )?.[1];
  assert.ok(gate, 'review gate program must stay testable');
  const behind = workflow.match(
    /BEHIND\)[\s\S]*?! jq -s -e "\$\{review_jq_defs\}"'\n([\s\S]*?)\n\s+' <\(printf/,
  )?.[1];
  assert.ok(behind, 'BEHIND transferable discovery guard must stay testable');
  for (const name of [
    'is_coderabbit',
    'is_trusted_human',
    'strip_markdown_code',
    'has_pstack_interrogate_marker',
    'is_valid_pstack_interrogate_on',
    'reduce_review_states',
    'is_current_pr_commit',
    'is_human_gate_discovery',
    'is_transferable_discovery',
    'is_gate_discovery',
    'states_are_clean',
    'has_clean_gate_discovery',
    'has_clean_transferable_discovery',
  ]) {
    assert.match(reviewJqDefs, new RegExp(`def ${name}[:(]`), `review_jq_defs must define ${name}`);
  }
  assert.ok(sync.includes('"${review_jq_defs}"'), 'marker sync must interpolate shared review_jq_defs');
  assert.match(gate, /has_clean_gate_discovery\(\$head; \.\[0\]; \.\[2\]\)/);
  assert.match(sync, /has_clean_gate_discovery\(\$head; \.\[0\]; \.\[1\]\)/);
  assert.match(behind, /has_clean_transferable_discovery\(\.\[0\]; \.\[1\]\)/);
  assert.doesNotMatch(sync, /MERGE_GH_TOKEN/);
  const reviewPathAt = workflow.indexOf('if [[ "${dependabot_compose}" != true ]]; then');
  const syncAt = workflow.indexOf('\n              sync_authorization_marker\n');
  assert.ok(reviewPathAt > 0 && syncAt > reviewPathAt, 'sync must live inside the non-Dependabot review path');
  assert.ok(syncAt > workflow.indexOf('comments="$(read_pages "repos/${repo}/issues/${pr}/comments")"'), 'sync must follow the comment read');
  assert.ok(syncAt < workflow.indexOf('# review-state-filter-begin'), 'sync must precede the review gate');
  assert.equal((workflow.match(/^\s+sync_authorization_marker$/gm) ?? []).length, 1, 'sync must be called only once');
});

const runSyncQueue = (workflow, prs, { hasPat = false } = {}) => {
  const queueLoop = workflow.match(/# queue-loop-begin\n([\s\S]*?)\n\s+# queue-loop-end/)?.[1];
  assert.ok(queueLoop, 'queue loop must stay testable');
  const dir = mkdtempSync(join(tmpdir(), 'automerge-sync-queue-'));
  const log = join(dir, 'gh.log');
  for (const pr of prs) {
    const head = pr.head;
    writeFileSync(join(dir, `pr-${pr.number}.json`), JSON.stringify({
      state: 'OPEN', isDraft: false, baseRefName: 'main', labels: [{ name: 'automerge' }],
      headRefName: `feature-${pr.number}`, headRefOid: head, headRepository: { nameWithOwner: 'o/r' },
      mergeStateStatus: pr.mergeStateStatus,
    }));
    writeFileSync(join(dir, `rest-${pr.number}.json`), JSON.stringify({
      head: { sha: head, ref: `feature-${pr.number}`, repo: { full_name: 'o/r' } },
      user: { login: 'owner', id: 1, type: 'User' },
    }));
    writeFileSync(join(dir, `files-${pr.number}.json`), JSON.stringify([{ filename: 'README.md', patch: '+x', additions: 1, deletions: 0, changes: 1 }]));
    writeFileSync(join(dir, `runs-${head}.json`), JSON.stringify({ total_count: 0, workflow_runs: [] }));
    writeFileSync(join(dir, `reviews-${pr.number}.json`), JSON.stringify(pr.reviews));
    writeFileSync(join(dir, `commits-${pr.number}.json`), JSON.stringify(pr.commits));
    writeFileSync(join(dir, `comments-${pr.number}.json`), JSON.stringify(pr.comments));
    for (const [page, events] of (pr.events ?? []).entries()) {
      writeFileSync(join(dir, `events-${pr.number}-${page + 1}.json`), JSON.stringify(events));
    }
    if (pr.headParents) {
      writeFileSync(join(dir, `commit-${head}.json`), JSON.stringify({ sha: head, parents: pr.headParents.map((sha) => ({ sha })) }));
    }
    for (const [baseSha, status] of Object.entries(pr.compare ?? {})) {
      writeFileSync(join(dir, `compare-${baseSha}.json`), JSON.stringify({ status }));
    }
    writeFileSync(join(dir, `threads-${pr.number}.json`), JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } },
    }));
    writeFileSync(join(dir, `checks-${head}.json`), JSON.stringify({
      check_runs: [{ id: 1, name: 'Platform CI', conclusion: 'success', started_at: '2026-08-01T00:00:00Z' }],
    }));
    writeFileSync(join(dir, `statuses-${head}.json`), JSON.stringify([]));
  }
  const script = [
    'set -euo pipefail',
    `GH_LOG=${JSON.stringify(log)}`,
    `FIX=${JSON.stringify(dir)}`,
    ': > "$GH_LOG"',
    'gh() {',
    `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
    '  local all="$*"',
    '  case "$all" in',
    `    *rate_limit*) printf '5000\\n' ;;`,
    `    "pr list"*) printf '%s\\n' ${JSON.stringify(JSON.stringify(prs.map((p) => p.number)))} ;;`,
    `    "api --method PUT repos/o/r/pulls/"*"/update-branch "*) printf 'TOKEN=%s\\n' "$GH_TOKEN" >> "$GH_LOG"; printf '%s\\n' '{"message":"Updating pull request branch."}' ;;`,
    `    "api --method PATCH repos/o/r/issues/comments/"*|"api --method POST repos/o/r/issues/"*"/comments "*) printf 'TOKEN=%s\\n' "$GH_TOKEN" >> "$GH_LOG"; id=77; [[ "$all" == *"issues/comments/"* ]] && { id="\${all#*issues/comments/}"; id="\${id%% *}"; }; jq -nc --argjson id "$id" --arg body "\${all#*body=}" '{id: $id, body: $body, user: {login: "github-actions[bot]", id: 41898282, type: "Bot"}}' ;;`,
    '    "api repos/o/r/commits/"*) h="${all#api repos/o/r/commits/}"; [[ -f "$FIX/commit-$h.json" ]] || return 1; cat "$FIX/commit-$h.json" ;;',
    '    "api repos/o/r/compare/"*) b="${all#api repos/o/r/compare/}"; b="${b%%...*}"; [[ -f "$FIX/compare-$b.json" ]] || return 1; jq -r .status "$FIX/compare-$b.json" ;;',
    '    *issues/*/events*) n="${all#*issues/}"; n="${n%%/events*}"; page="${all##*page=}"; [[ -f "$FIX/events-$n-$page.json" ]] || return 1; cat "$FIX/events-$n-$page.json" ;;',
    '    "pr view "*"--json headRefOid --jq .headRefOid") set -- $all; jq -r .headRefOid "$FIX/pr-$3.json" ;;',
    '    "pr view "*) set -- $all; cat "$FIX/pr-$3.json" ;;',
    '    *repos/*/pulls/*/files*) n="${all#*pulls/}"; n="${n%%/files*}"; cat "$FIX/files-$n.json" ;;',
    '    *issues/*/comments*) n="${all#*issues/}"; n="${n%%/comments*}"; cat "$FIX/comments-$n.json" ;;',
    '    *pulls/*/commits*) n="${all#*pulls/}"; n="${n%%/commits*}"; cat "$FIX/commits-$n.json" ;;',
    '    *pulls/*/reviews*) n="${all#*pulls/}"; n="${n%%/reviews*}"; cat "$FIX/reviews-$n.json" ;;',
    '    *actions/runs*) h="${all#*head_sha=}"; h="${h%%&*}"; cat "$FIX/runs-$h.json" ;;',
    '    *repos/*/pulls/*) n="${all#*pulls/}"; n="${n%% *}"; cat "$FIX/rest-$n.json" ;;',
    '    *graphql*) n="${all#*number=}"; n="${n%% *}"; cat "$FIX/threads-$n.json" ;;',
    '    *check-runs*) h="${all#*commits/}"; h="${h%%/check-runs*}"; cat "$FIX/checks-$h.json" ;;',
    '    *statuses*) h="${all#*commits/}"; h="${h%%/statuses*}"; cat "$FIX/statuses-$h.json" ;;',
    '    "pr merge"* | "pr comment"* | "pr edit"*) ;;',
    `    *) printf 'unstubbed gh call: %s\\n' "$all" >&2; return 1 ;;`,
    '  esac',
    '}',
    'repo=o/r',
    'owner=o',
    'name=r',
    'GITHUB_SERVER_URL=https://github.com',
    'GITHUB_REPOSITORY=o/r',
    'GITHUB_RUN_ID=1234',
    'GH_TOKEN=github-token',
    'MERGE_GH_TOKEN=merge-token',
    `HAS_AUTOMERGE_PAT=${hasPat}`,
    `required='[{"context":"Platform CI","integration_id":null}]'`,
    'candidates="$(gh pr list)"',
    budgetConstantsOf(workflow),
    dedent(queueLoop),
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const merged = calls.match(/gh pr merge --squash (\d+) --repo/)?.[1];
  return { status: result.status, mergedPr: merged ? Number(merged) : null, calls, stdout: result.stdout, stderr: result.stderr };
};

test('코디네이터 base 갱신 기록 뒤 다음 실행은 marker를 재발행해 병합하고, 세션 병합 커밋·라벨 이후 head는 승인하지 않는다', async () => {
  const workflow = await readWorkflow();
  const previous = 'b'.repeat(40);
  const head = 'c'.repeat(40);
  const mainParent = 'd'.repeat(40);
  const secondHead = 'e'.repeat(40);
  const markerComment = { id: 99, body: markerFor(previous), user: actionsBotUser };
  const codeRabbit = {
    author_association: 'NONE',
    body: '',
    user: { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' },
  };

  const requestedCodeRabbit = runSyncQueue(workflow, [{
    number: 1, head: previous, mergeStateStatus: 'BEHIND',
    comments: [markerComment], reviews: [discoveryReview(previous, codeRabbit)], commits: [{ sha: previous }],
  }], { hasPat: true });
  assert.equal(requestedCodeRabbit.status, 0, requestedCodeRabbit.stderr);
  assert.equal(requestedCodeRabbit.mergedPr, null);
  assert.doesNotMatch(requestedCodeRabbit.calls, /--remove-label automerge/, 'BEHIND with CodeRabbit and PAT must not hand off');
  assert.match(requestedCodeRabbit.calls, new RegExp(`update-branch -f expected_head_sha=${previous}\\nTOKEN=merge-token\\n`));
  const recordBody = requestedCodeRabbit.calls.match(
    /gh api --method POST repos\/o\/r\/issues\/1\/comments -f body=(<!-- Automerge base update requested: [0-9a-f]{40} -->)\nTOKEN=github-token\n/,
  )?.[1];
  assert.equal(recordBody, recordFor(previous), 'the accepted base update must be recorded for head P');

  const codeRabbitCandidate = {
    number: 1, head, mergeStateStatus: 'CLEAN',
    comments: [markerComment, { id: 100, body: recordBody, user: actionsBotUser }],
    reviews: [discoveryReview(previous, codeRabbit)],
    commits: [{ sha: previous }, { sha: head }],
    headParents: [previous, mainParent],
    compare: { [mainParent]: 'ahead' },
  };
  const reissuedCodeRabbit = runSyncQueue(workflow, [codeRabbitCandidate]);
  assert.equal(reissuedCodeRabbit.status, 0, reissuedCodeRabbit.stderr);
  assert.match(reissuedCodeRabbit.calls, new RegExp(`gh api --method PATCH repos/o/r/issues/comments/99 -f body=${markerFor(head)}\\nTOKEN=github-token\\n`));
  assert.equal(reissuedCodeRabbit.mergedPr, 1, 'CodeRabbit review on previous commit must merge after coordinator base-update');

  const cleanSecondCandidate = {
    number: 2,
    head: secondHead,
    mergeStateStatus: 'CLEAN',
    comments: [{ id: 201, body: markerFor(secondHead), user: actionsBotUser }],
    reviews: [discoveryReview(secondHead)],
    commits: [{ sha: secondHead }],
  };
  const earlier = 'a'.repeat(40);
  for (const [label, nonTransferableReviews, behindCommits] of [
    ['pstack-interrogate only', [discoveryReview(previous)], [{ sha: previous }]],
    ['APPROVED only', [discoveryReview(previous, { state: 'APPROVED', body: '' })], [{ sha: previous }]],
    [
      'unresolved ACT_ON_PRIOR from another reviewer alongside CodeRabbit and current act-on=0',
      [
        discoveryReview(earlier, {
          id: 5,
          submitted_at: '2026-09-29T00:00:00Z',
          body: interrogateDiscoveryBody(earlier, 1),
          user: { login: 'reviewer-one', type: 'User' },
        }),
        discoveryReview(previous, {
          id: 6,
          submitted_at: '2026-09-29T00:01:00Z',
          body: interrogateDiscoveryBody(previous, 0),
          user: { login: 'reviewer-two', type: 'User' },
        }),
        discoveryReview(previous, {
          ...codeRabbit,
          id: 7,
          submitted_at: '2026-09-29T00:02:00Z',
        }),
      ],
      [{ sha: earlier }, { sha: previous }],
    ],
  ]) {
    const handedOffBehind = runSyncQueue(
      workflow,
      [
        {
          number: 1,
          head: previous,
          mergeStateStatus: 'BEHIND',
          comments: [markerComment],
          reviews: nonTransferableReviews,
          commits: behindCommits,
        },
        cleanSecondCandidate,
      ],
      { hasPat: true },
    );
    assert.equal(handedOffBehind.status, 0, `${label}: ${handedOffBehind.stderr}`);
    assert.doesNotMatch(handedOffBehind.calls, /update-branch/, `${label} BEHIND must not call update-branch`);
    assert.match(handedOffBehind.calls, /gh pr edit 1 --repo o\/r --remove-label automerge/, `${label} BEHIND must hand off PR #1`);
    assert.match(handedOffBehind.calls, /gh pr comment 1 --repo o\/r --body/, `${label} BEHIND must post the rebase notice`);
    assert.equal(handedOffBehind.mergedPr, 2, `${label} BEHIND handoff must not block subsequent CLEAN candidate`);
  }

  const gatedOutBehindChangesRequested = runSyncQueue(
    workflow,
    [
      {
        number: 1,
        head: previous,
        mergeStateStatus: 'BEHIND',
        comments: [markerComment],
        reviews: [
          discoveryReview(earlier, {
            id: 5,
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-09-29T00:00:00Z',
            body: '',
          }),
          discoveryReview(earlier, {
            id: 6,
            submitted_at: '2026-09-29T00:01:00Z',
            body: interrogateDiscoveryBody(earlier, 0),
          }),
          discoveryReview(previous, {
            ...codeRabbit,
            id: 7,
            submitted_at: '2026-09-29T00:02:00Z',
          }),
        ],
        commits: [{ sha: earlier }, { sha: previous }],
      },
      cleanSecondCandidate,
    ],
    { hasPat: true },
  );
  assert.equal(gatedOutBehindChangesRequested.status, 0, gatedOutBehindChangesRequested.stderr);
  assert.doesNotMatch(
    gatedOutBehindChangesRequested.calls,
    /update-branch/,
    'CHANGES_REQUESTED followed by prior act-on=0 must never reach update-branch on BEHIND',
  );
  assert.equal(gatedOutBehindChangesRequested.mergedPr, 2);

  const sameReviewerResolvedPriorActOn = [
    discoveryReview(previous, {
      id: 5,
      submitted_at: '2026-09-29T00:00:00Z',
      body: interrogateDiscoveryBody(previous, 1),
    }),
    discoveryReview(previous, {
      id: 6,
      submitted_at: '2026-09-29T00:01:00Z',
      body: interrogateDiscoveryBody(previous, 0),
    }),
    discoveryReview(previous, {
      ...codeRabbit,
      id: 7,
      submitted_at: '2026-09-29T00:02:00Z',
    }),
  ];
  const behindResolvedPriorActOn = runSyncQueue(
    workflow,
    [{
      number: 1,
      head: previous,
      mergeStateStatus: 'BEHIND',
      comments: [markerComment],
      reviews: sameReviewerResolvedPriorActOn,
      commits: [{ sha: previous }],
    }],
    { hasPat: true },
  );
  assert.equal(behindResolvedPriorActOn.status, 0, behindResolvedPriorActOn.stderr);
  assert.doesNotMatch(
    behindResolvedPriorActOn.calls,
    /--remove-label automerge/,
    'same-reviewer resolved ACT_ON_PRIOR with CodeRabbit must request base update on BEHIND',
  );
  assert.match(
    behindResolvedPriorActOn.calls,
    new RegExp(`update-branch -f expected_head_sha=${previous}\\nTOKEN=merge-token\\n`),
  );
  const mergedResolvedPriorActOn = runSyncQueue(workflow, [{
    ...codeRabbitCandidate,
    reviews: sameReviewerResolvedPriorActOn,
  }]);
  assert.equal(mergedResolvedPriorActOn.status, 0, mergedResolvedPriorActOn.stderr);
  assert.equal(
    mergedResolvedPriorActOn.mergedPr,
    1,
    'same-reviewer resolved ACT_ON_PRIOR must survive BEHIND merge commit alongside CodeRabbit',
  );

  const changesRequestedPlusPriorActOnZeroAfterBaseUpdate = runSyncQueue(workflow, [{
    ...codeRabbitCandidate,
    reviews: [
      discoveryReview(previous, {
        id: 5,
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-09-29T00:00:00Z',
        body: '',
      }),
      discoveryReview(previous, {
        id: 6,
        submitted_at: '2026-09-29T00:01:00Z',
        body: interrogateDiscoveryBody(previous, 0),
      }),
      discoveryReview(previous, {
        ...codeRabbit,
        id: 7,
        submitted_at: '2026-09-29T00:02:00Z',
      }),
    ],
  }]);
  assert.equal(
    changesRequestedPlusPriorActOnZeroAfterBaseUpdate.status,
    0,
    changesRequestedPlusPriorActOnZeroAfterBaseUpdate.stderr,
  );
  assert.equal(
    changesRequestedPlusPriorActOnZeroAfterBaseUpdate.mergedPr,
    null,
    'prior act-on=0 must never clear CHANGES_REQUESTED after base-update',
  );

  const staleInterrogateAfterBaseUpdate = runSyncQueue(workflow, [{
    ...codeRabbitCandidate,
    reviews: [discoveryReview(previous)],
  }]);
  assert.equal(staleInterrogateAfterBaseUpdate.status, 0, staleInterrogateAfterBaseUpdate.stderr);
  assert.match(staleInterrogateAfterBaseUpdate.calls, new RegExp(`gh api --method PATCH repos/o/r/issues/comments/99 -f body=${markerFor(head)}\\nTOKEN=github-token\\n`));
  assert.equal(
    staleInterrogateAfterBaseUpdate.mergedPr,
    null,
    'pstack-interrogate review on previous commit must be rejected on the new base-updated head',
  );

  const priorInterrogateAlongsideCodeRabbitAfterBaseUpdate = runSyncQueue(workflow, [{
    ...codeRabbitCandidate,
    reviews: [discoveryReview(previous, codeRabbit), discoveryReview(previous, { id: 6 })],
  }]);
  assert.equal(
    priorInterrogateAlongsideCodeRabbitAfterBaseUpdate.status,
    0,
    priorInterrogateAlongsideCodeRabbitAfterBaseUpdate.stderr,
  );
  assert.equal(
    priorInterrogateAlongsideCodeRabbitAfterBaseUpdate.mergedPr,
    1,
    'valid act-on=0 on prior head must stay benign COMMENTED alongside CodeRabbit after base-update',
  );

  const actOnBlockingCodeRabbitAfterBaseUpdate = runSyncQueue(workflow, [{
    ...codeRabbitCandidate,
    reviews: [
      discoveryReview(previous, codeRabbit),
      discoveryReview(head, { id: 6, body: interrogateDiscoveryBody(head, 1) }),
    ],
  }]);
  assert.equal(actOnBlockingCodeRabbitAfterBaseUpdate.status, 0, actOnBlockingCodeRabbitAfterBaseUpdate.stderr);
  assert.equal(
    actOnBlockingCodeRabbitAfterBaseUpdate.mergedPr,
    null,
    'pstack-interrogate with act-on>0 on new head must block CodeRabbit via ACT_ON_CURRENT',
  );

  const freshInterrogateAfterBaseUpdate = runSyncQueue(workflow, [{
    ...codeRabbitCandidate,
    reviews: [discoveryReview(previous), discoveryReview(head, { id: 6 })],
  }]);
  assert.equal(freshInterrogateAfterBaseUpdate.status, 0, freshInterrogateAfterBaseUpdate.stderr);
  assert.equal(
    freshInterrogateAfterBaseUpdate.mergedPr,
    1,
    'pstack-interrogate review on the new base-updated head must pass and merge',
  );

  const sessionMerge = runSyncQueue(workflow, [{
    ...codeRabbitCandidate,
    comments: [markerComment],
    reviews: [discoveryReview(head)],
  }]);
  assert.equal(sessionMerge.status, 0, sessionMerge.stderr);
  assert.doesNotMatch(sessionMerge.calls, /--method (PATCH|POST)/);
  assert.equal(sessionMerge.mergedPr, null, 'a session-pushed merge commit must wait for a new label authorization');

  const recovery = {
    ...codeRabbitCandidate,
    comments: [],
    reviews: [discoveryReview(head)],
    headParents: undefined,
    compare: undefined,
    commits: [committedAt(previous, '2026-09-29T00:00:00Z'), committedAt(head, '2026-09-29T01:00:00Z')],
  };
  const pushedAfterLabel = runSyncQueue(workflow, [{ ...recovery, events: [[labeledAt('2026-09-29T00:30:00Z')]] }]);
  assert.equal(pushedAfterLabel.status, 0, pushedAfterLabel.stderr);
  assert.doesNotMatch(pushedAfterLabel.calls, /--method (PATCH|POST)/, 'a head pushed after the label must not be recovered');
  assert.equal(pushedAfterLabel.mergedPr, null);

  const recovered = runSyncQueue(workflow, [{ ...recovery, events: [[labeledAt('2026-09-29T02:00:00Z')]] }]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.calls, new RegExp(`gh api --method POST repos/o/r/issues/1/comments -f body=${markerFor(head)}\\nTOKEN=github-token\\n`));
  assert.equal(recovered.mergedPr, 1, 'a recovered marker must satisfy the unchanged review gate in the same run');
});

// #3036: 큐를 다시 깨울 이벤트가 오지 않는 공백을 schedule tick이 메운다. 한 run이 후보를 일시적 상태(대기 중 check)로
// 읽고 건너뛰면 그 상태가 풀려도 이 워크플로가 구독하는 이벤트는 나오지 않는다(backend 2026-10-22 #539·#542).
// 빈 큐 tick은 checkout 없이 목록 조회 한 번으로 끝나야 한다.
const PROBE_JOB_RE = /\n {2}queue-probe:\n([\s\S]*?)\n {2}coordinate:\n/;
const COORDINATE_HEAD_RE = /\n {2}coordinate:\n([\s\S]*?)\n {4}steps:\n/;

const scheduleMinutesOf = (workflow) => {
  const cron = workflow.match(/\n {2}schedule:\n {4}- cron: "([^"]+)"\n/)?.[1];
  assert.ok(cron, 'schedule cron trigger is missing');
  const [minute, ...rest] = cron.split(' ');
  assert.deepEqual(rest, ['*', '*', '*', '*'], 'the tick must fire every hour of every day');
  return minute.split(',').map(Number);
};

const runQueueProbe = (workflow, { listOutput = '0', listFails = false } = {}) => {
  const job = workflow.match(PROBE_JOB_RE)?.[1];
  assert.ok(job, 'queue-probe job must precede coordinate');
  const script = job.match(/\n {8}run: \|\n([\s\S]*)$/)?.[1];
  assert.ok(script, 'queue-probe must have one run block');
  for (const line of script.split('\n').filter((l) => l.trim() !== '')) {
    assert.ok(line.startsWith(' '.repeat(10)), `probe run line escapes the YAML block scalar: ${line.slice(0, 48)}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'automerge-probe-'));
  const log = join(dir, 'gh.log');
  const output = join(dir, 'output');
  const result = spawnSync(
    'bash',
    [
      '-c',
      [
        `GH_LOG=${JSON.stringify(log)}`,
        `GITHUB_OUTPUT=${JSON.stringify(output)}`,
        'GITHUB_REPOSITORY=o/r',
        ': > "$GH_LOG"; : > "$GITHUB_OUTPUT"',
        'gh() {',
        '  printf "%s\\n" "gh $*" >> "$GH_LOG"',
        listFails ? '  return 1' : `  printf "%s\\n" ${JSON.stringify(listOutput)}`,
        '}',
        dedent(script),
      ].join('\n'),
    ],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    output: readFileSync(output, 'utf8'),
    calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
};

test('schedule tick이 이벤트 없이도 큐를 다시 판정하고 빈 큐에서는 목록 조회 한 번으로 끝난다', async () => {
  const workflow = await readWorkflow();

  const minutes = scheduleMinutesOf(workflow);
  assert.ok(minutes.every((m) => Number.isInteger(m) && m > 0 && m < 60), 'tick minutes must avoid the top of the hour');
  const sorted = [...minutes].sort((a, b) => a - b);
  const gaps = sorted.map((m, i) => (i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 60) - m);
  assert.ok(Math.max(...gaps) <= 15, `tick interval must stay within 15 minutes: ${gaps}`);

  const probe = workflow.match(PROBE_JOB_RE)?.[1] ?? '';
  assert.match(probe, /\n {4}if: github\.event_name == 'schedule'\n/);
  assert.match(probe, /\n {4}permissions:\n {6}pull-requests: read\n {4}outputs:/);
  assert.doesNotMatch(probe, /uses:/, 'the probe must not check out or call actions');

  const idle = runQueueProbe(workflow, { listOutput: '0' });
  assert.equal(idle.status, 0, idle.stderr);
  assert.equal(idle.output, 'labeled=false\n');
  assert.equal(idle.calls.length, 1);
  assert.match(idle.calls[0], /^gh pr list --repo o\/r --base main --state open --label automerge --draft=false --limit 1 /);

  assert.equal(runQueueProbe(workflow, { listOutput: '1' }).output, 'labeled=true\n');

  for (const broken of [{ listFails: true }, { listOutput: 'oops' }]) {
    const result = runQueueProbe(workflow, broken);
    assert.notEqual(result.status, 0, 'an unreadable queue must fail the probe, not report it empty');
    assert.equal(result.output, '');
  }
});

test('coordinate는 schedule에서 라벨 PR이 있을 때만 돌고 동시성 그룹은 coordinate job만 점유한다', async () => {
  const workflow = await readWorkflow();
  const head = workflow.match(COORDINATE_HEAD_RE)?.[1] ?? '';

  assert.match(head, /\n {4}needs: queue-probe\n/);
  // 이 if를 이벤트별로 평가해 볼 수 있는 평가기가 이 저장소에 없다. 첫 &&가 ||로 바뀌면 probe가 실패하거나 라벨 PR이 없다고 답해도
  // schedule tick이 coordinate를 띄우므로, 식 전체를 한 글자도 다르지 않게 고정한다.
  assert.equal(head.match(/\n {4}(if: .+)\n/)?.[1], COORDINATE_IF, 'coordinate if must match the pinned expression');
  // 빈 큐 tick이 그룹에 들어가면 대기 중인 라벨 run을 밀어낼 수 있다. 그룹은 coordinate job에만 둔다.
  assert.match(head, /\n {4}concurrency:\n {6}group: automerge-queue\n {6}cancel-in-progress: false\n/);
  assert.doesNotMatch(workflow, /^concurrency:/m);
});

test('워크플로의 모든 jq 호출이 단일 인용·평탄화 규칙과 ((<lhs>) as $<var> | <body>) AST 계약을 지키고 jq 컴파일을 통과한다', async () => {
  for (const [label, badSource] of [
    ['unparenthesized lhs', '(.foo as $x | $x)'],
    ['missing outer grouping parens', '(.foo) as $x | $x'],
    ['nested second as without own outer parens', '((.a) as $x | (.b) as $y | $x + $y)'],
    ['call paren masquerading as outer grouping paren', 'any((.foo) as $x | $x)'],
    ['semicolon inside outer grouping level', 'def f(a; b): a; f((.foo) as $x | $x; 1)'],
    ['object destructuring without outer parens', '(.foo) as {a: $a} | $a'],
    ['array destructuring without outer parens', '(.foo) as [$a] | $a'],
    ['string interpolation violation', '"\\((.foo) as $x | $x)"'],
    ['as following reduce outside header', 'reduce .[] as $r ({}; .) | (.foo) as $x | $x'],
  ]) {
    const verdict = validateJqAsBindings(badSource);
    assert.equal(verdict.ok, false, `validator must reject ${label}: ${badSource}`);
  }

  for (const [label, goodSource] of [
    ['properly wrapped single binding', '((.foo) as $x | $x)'],
    ['properly wrapped nested bindings', '((.a) as $x | ((.b) as $y | $x + $y))'],
    ['reduce header binding', 'reduce (.items[] | select(.ok)) as $item ({}; . + $item)'],
    ['foreach header binding', '[foreach .[] as $item (0; . + $item; .)]'],
    ['destructuring wrapped properly', '((.foo) as {a: $a} | $a)'],
    ['string interpolation wrapped properly', '"\\(((.foo) as $x | $x))"'],
    ['literal "as $x" inside string', '"foo as $x | bar"'],
  ]) {
    const verdict = validateJqAsBindings(goodSource);
    assert.equal(verdict.ok, true, `validator must accept ${label}: ${verdict.reason ?? ''}`);
  }

  for (const [label, badWorkflowSnippet] of [
    ['double-quoted jq filter', 'run: |\n  jq -e ".foo" <<<"$x"\n'],
    ['double-quoted --jq filter', 'run: |\n  gh api rate_limit --jq ".resources"\n'],
    ['unquoted jq filter', 'run: |\n  jq -r .foo <<<"$x"\n'],
    ['unquoted --jq filter', 'run: |\n  gh pr view 1 --json headRefOid --jq .headRefOid\n'],
    ['unknown prefix variable', 'run: |\n  jq -e "${unknown_defs}"\'.foo\' <<<"$x"\n'],
    ['nested $(jq ...) inside --argjson', 'run: |\n  jq -c --argjson x "$(jq -c \'.\' <<<"{}")" \'.\' <<<"{}"\n'],
    ['quoted nested $(...) in trailing jq positional arg', 'run: |\n  jq \'.\' "$(jq \'.\' <<<"{}")"\n'],
    ['unquoted nested $(...) in trailing jq positional arg', 'run: |\n  jq \'.\' $(jq \'.\' <<<"{}")\n'],
    ['nested $(...) in jq here-string', 'run: |\n  jq \'.\' <<<"$(jq -r \'. as $x | $x\' <<<\'{}\')"\n'],
    ['gh -q shorthand', 'run: |\n  gh api rate_limit -q \'. as $x | $x\'\n'],
    ['+= query mutation', 'run: |\n  q_query=\'.x\'\n  q_query+=\' | . as $x | $x\'\n  gh api x --jq "${q_query}"\n'],
    ['eval command wrapper', 'run: |\n  eval "jq -r \'. as \\$x | \\$x\' <<<\'{}\'"\n'],
    ['bash -c subshell bypass', 'run: |\n  bash -c "jq -r \'. as \\$x | \\$x\' <<<\'{}\'"\n'],
    ['non-JQ heredoc jq reference', 'run: |\n  msg="$(cat <<\'EOF\'\njq -r \'. as $x | $x\'\nEOF\n)"\n'],
    ['quoted YAML run key', "'run': |\n  jq -r '. as $x | $x' <<<'{}'\n"],
    ['folded YAML run scalar', 'name: T\non: push\njobs:\n  t:\n    steps:\n      - run: >\n          jq -r \'. as $x | $x\' <<<\'{}\'\n'],
  ]) {
    const rejected = auditWorkflowJqInvocations(badWorkflowSnippet);
    assert.equal(rejected.ok, false, `auditor must fail closed on ${label}: ${badWorkflowSnippet}`);
  }

  const automergeWorkflow = await readWorkflow();
  const defs = [
    ...automergeWorkflow.matchAll(/def strip_markdown_code\(\$keep_unclosed\):[\s\S]*?;\n/g),
  ].map((m) => m[0]);
  assert.equal(defs.length, 1, 'shared strip_markdown_code($keep_unclosed) definition must be audited');
  assert.doesNotMatch(
    defs[0],
    /`/,
    'strip_markdown_code($keep_unclosed) must use \\x60 instead of literal backticks',
  );

  const audit = auditWorkflowJqInvocations(automergeWorkflow);
  assert.equal(audit.ok, true, `automerge-queue.yml jq invocation audit failed: ${audit.reason ?? ''}`);
  assert.ok(
    audit.commandCount >= 50,
    `automerge-queue.yml: expected at least 50 audited jq invocations, got ${audit.commandCount}`,
  );

  const commentStrippedWorkflow = automergeWorkflow
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const totalWorkflowAsBindings = [...commentStrippedWorkflow.matchAll(/\bas\s*(?:\$[A-Za-z_][A-Za-z0-9_]*|\{|\[)/g)].length;
  let checkedNonReduce = 0;
  let checkedLoop = 0;
  for (const program of audit.programs) {
    const result = validateJqAsBindings(program);
    assert.equal(
      result.ok,
      true,
      `jq program violates ((<lhs>) as $<var> | <body>): ${result.reason ?? ''}\n${program}`,
    );
    checkedNonReduce += result.nonReduceCount;
    checkedLoop += result.loopCount;
  }
  assert.equal(
    checkedNonReduce + checkedLoop,
    totalWorkflowAsBindings,
    `every jq 'as' binding in automerge-queue.yml must be AST-checked (${checkedNonReduce} + ${checkedLoop} vs ${totalWorkflowAsBindings})`,
  );
});

test('워크플로와 모든 PR 템플릿이 현재 head의 pstack interrogate 단일 마커 계약을 안내하고 은퇴한 폴백 문구를 남기지 않는다', async () => {
  const workflow = await readWorkflow();
  assert.doesNotMatch(workflow, /Aquila Universal Review|Aquila fallback|aquila-review|Codex CLI fallback/);
  assert.match(workflow, /pstack-interrogate/);

  const expectedLine =
    '- [ ] 현재 head에 대한 `pstack` `interrogate` Review(`<!-- pstack-interrogate head=<40자 sha> act-on=0 -->`)를 단일 PR review로 게시했습니다.';
  for (const templateUrl of prTemplateUrls) {
    const content = await readFile(templateUrl, 'utf8');
    assert.doesNotMatch(
      content,
      /aquila-review|Aquila 마커|Codex|폴백 리뷰|CodeRabbit Review 객체가 없으면/i,
      `${templateUrl.pathname} must not contain retired fallback wording`,
    );
    assert.ok(
      content.includes(expectedLine),
      `${templateUrl.pathname} must include the exact pstack interrogate checklist item`,
    );
  }
});
