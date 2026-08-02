import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflowUrl = new URL(
  '../../.github/workflows/automerge-queue.yml',
  import.meta.url,
);
const ciWorkflowUrl = new URL('../../.github/workflows/ci.yml', import.meta.url);
const workflowsDirUrl = new URL('../../.github/workflows/', import.meta.url);

const readWorkflow = () => readFile(workflowUrl, 'utf8');

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

test('코디네이터는 PAT 없이 GITHUB_TOKEN으로만 동작한다', async () => {
  const workflow = await readWorkflow();

  for (const contract of [
    'GH_TOKEN: ${{ github.token }}',
    'pull_request_target:',
    'workflow_run:',
    'workflow_dispatch:',
    'schedule:',
    'cron: "*/10 * * * *"',
    'permissions: {}',
    'actions: write',
    'checks: read',
    'statuses: read',
    'contents: write',
    'pull-requests: write',
  ]) {
    assert.ok(workflow.includes(contract), `missing contract: ${contract}`);
  }

  // PAT 의존은 형제 저장소의 큐를 통째로 정지시킨 원인이다. 어떤 형태로도 남기지 않는다.
  assert.doesNotMatch(workflow, /AUTOMERGE_PAT/);
  assert.doesNotMatch(workflow, /secrets\./);
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

test('classic commit status는 전 페이지를 모아 판정한다', async () => {
  const workflow = await readWorkflow();

  const statusRequest = workflow.match(/statuses="\$\(gh api ([\s\S]*?)"\)"/)?.[1];
  assert.ok(statusRequest, 'classic status request must stay testable');
  for (const flag of [
    '--paginate',
    '--slurp',
    '/commits/${head}/statuses?per_page=100',
  ]) {
    assert.ok(statusRequest.includes(flag), `status request missing: ${flag}`);
  }
  // `/status`는 조합 결과를 단일 객체로 주고 페이지네이션되지 않는다. `/statuses`여야 한다.
  assert.doesNotMatch(statusRequest, /\/commits\/\$\{head\}\/status\?/);
  assert.ok(workflow.includes('($statuses | flatten) as $status_records'));
});

test('리뷰 게이트는 전 커밋의 활성 상태와 current head 긍정 리뷰를 함께 요구한다', async () => {
  const workflow = await readWorkflow();

  const reviewProgram = workflow.match(
    /# review-state-filter-begin\n[\s\S]*?if ! jq -e --arg head "\$\{head\}" '\n([\s\S]*?)\n\s+' <<<"\$\{reviews\}" >\/dev\/null; then/,
  )?.[1];
  assert.ok(reviewProgram, 'review state jq program must stay testable');

  const fallbackBody =
    '**Actionable comments posted: 0**\n<!-- Review source: Codex CLI fallback; canonical visible structure: PR #1926 Review 4676157515 -->';
  const review = (id, state, submittedAt, body = '', overrides = {}) => ({
    id,
    state,
    submitted_at: submittedAt,
    commit_id: 'head',
    author_association: 'OWNER',
    body,
    user: { login: 'reviewer' },
    ...overrides,
  });
  const runReviewFilter = (reviews) => {
    const result = spawnSync('jq', ['-e', '--arg', 'head', 'head', reviewProgram], {
      input: JSON.stringify([reviews]),
      encoding: 'utf8',
    });
    // jq -e는 결과가 false/null이면 1, 컴파일 오류면 3, 런타임 오류면 5를 낸다.
    // 0/1만 판정으로 인정해야 프로그램 파손이 "차단 성공"으로 새지 않는다.
    assert.ok(
      result.status === 0 || result.status === 1,
      `jq 하네스 파손 (status ${result.status}): ${result.stderr}`,
    );
    return result.status;
  };

  // 기본 판정.
  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z'),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z'),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z')]),
    0,
  );
  // 폴백 리뷰는 규약 양식의 제목줄과 provenance marker를 모두 가져야 한다.
  assert.equal(
    runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', fallbackBody)]),
    0,
  );
  // 신뢰되지 않는 author_association은 어떤 본문으로도 게이트를 통과하지 못한다.
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', fallbackBody, {
        author_association: 'NONE',
      }),
    ]),
    0,
  );

  // 이전 head에 남은 활성 change request는 head가 바뀌어도 게이트에서 사라지지 않는다.
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        commit_id: 'previous-head',
        user: { login: 'reviewer-one' },
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        user: { login: 'reviewer-two' },
      }),
    ]),
    0,
  );
  // 폴백 리뷰가 current head에 있어도 다른 리뷰어의 이전 head change request는 막는다.
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        commit_id: 'previous-head',
        user: { login: 'reviewer-one' },
      }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', fallbackBody, {
        user: { login: 'reviewer-two' },
      }),
    ]),
    0,
  );
  // 같은 리뷰어가 current head에서 승인하면 이전 change request는 해소된다.
  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        commit_id: 'previous-head',
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z'),
    ]),
    0,
  );
  // 긍정 리뷰는 여전히 current head를 요구한다.
  assert.notEqual(
    runReviewFilter([
      review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', {
        commit_id: 'previous-head',
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', fallbackBody, {
        commit_id: 'previous-head',
      }),
    ]),
    0,
  );

  // dismiss된 change request는 활성이 아니므로 큐를 막지 않는다.
  assert.equal(
    runReviewFilter([
      review(1, 'DISMISSED', '2026-08-01T00:00:00Z', '', {
        commit_id: 'previous-head',
        user: { login: 'reviewer-one' },
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        user: { login: 'reviewer-two' },
      }),
    ]),
    0,
  );
  // dismiss_stale_reviews_on_push로 무효화된 이전 head 승인도 큐를 막지 않는다.
  // 이 저장소 main ruleset은 dismiss_stale_reviews_on_push: true다.
  assert.equal(
    runReviewFilter([
      review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', {
        commit_id: 'previous-head',
        user: { login: 'reviewer-one' },
      }),
      review(2, 'DISMISSED', '2026-08-01T00:01:00Z', '', {
        commit_id: 'previous-head',
        user: { login: 'reviewer-one' },
      }),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-two' },
      }),
    ]),
    0,
  );
  // dismissed가 섞여 있어도 다른 리뷰어의 활성 change request는 그대로 막는다.
  assert.notEqual(
    runReviewFilter([
      review(1, 'DISMISSED', '2026-08-01T00:00:00Z', '', {
        commit_id: 'previous-head',
        user: { login: 'reviewer-one' },
      }),
      review(2, 'CHANGES_REQUESTED', '2026-08-01T00:01:00Z', '', {
        commit_id: 'previous-head',
        user: { login: 'reviewer-two' },
      }),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-three' },
      }),
    ]),
    0,
  );
  // dismiss 이후 같은 리뷰어가 다시 남긴 change request는 정상 반영된다.
  assert.notEqual(
    runReviewFilter([
      review(1, 'DISMISSED', '2026-08-01T00:00:00Z', '', {
        commit_id: 'previous-head',
        user: { login: 'reviewer-one' },
      }),
      review(2, 'CHANGES_REQUESTED', '2026-08-01T00:01:00Z', '', {
        commit_id: 'previous-head',
        user: { login: 'reviewer-one' },
      }),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-two' },
      }),
    ]),
    0,
  );
  // dismissed 리뷰만 남으면 활성 리뷰가 없으므로 fail closed로 막는다.
  assert.notEqual(
    runReviewFilter([
      review(1, 'DISMISSED', '2026-08-01T00:00:00Z', '', {
        commit_id: 'previous-head',
      }),
    ]),
    0,
  );

  // PR 작성자가 게시한 리뷰도 게이트에서 인정한다. 형제 저장소(backend·mobile)와 판정을
  // 일치시키기 위한 오너 결정이며, 네 저장소가 같은 입력에 같은 판정을 내야 한다.
  // 신뢰 기준은 author_association 하나다.
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', fallbackBody, {
        user: { login: 'pr-author' },
      }),
    ]),
    0,
  );
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

  const runContextLoop = (checkRuns) => {
    const result = stubbedBash([
      'set -euo pipefail',
      'pr=39',
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
    stdout: 'REACHED_DISPATCH\n',
  });
  // 진행 중(pending)과 미부착(missing)은 조용히 이 후보만 건너뛴다.
  for (const checkRuns of [run(null), []]) {
    const result = runContextLoop(checkRuns);
    assert.equal(result.status, 0);
    assert.equal(result.reached, false, '대기 상태는 병합 분기에 닿으면 안 된다');
    assert.equal(result.warned, false, '대기 상태는 사람이 볼 신호가 아니다');
  }
  // 명시적 실패도 실행을 죽이지 않고 이 후보만 건너뛰되, 신호는 남긴다.
  const failed = runContextLoop(run('failure'));
  assert.equal(failed.status, 0);
  assert.equal(failed.reached, false);
  assert.equal(failed.warned, true, 'required context 실패는 ::warning::으로 드러나야 한다');
});

test('merge-state 분기는 상태별로 병합·물러남·건너뛰기를 구분한다', async () => {
  const workflow = await readWorkflow();

  const dispatchBlock = workflow.match(
    /# merge-state-dispatch-begin\n([\s\S]*?)\n\s+# merge-state-dispatch-end/,
  )?.[1];
  assert.ok(dispatchBlock, 'merge state dispatch must stay testable');

  // gh 호출을 기록만 하는 스텁으로 대체해 상태별 분기 결과를 실측한다. 분기는 큐 루프
  // 안에 있으므로 `continue`가 유효하도록 1회 루프로 감싸고, 루프를 빠져나오면
  // SKIPPED를 남겨 "이 후보를 건너뛰었다"를 관측한다.
  const runDispatch = (
    mergeState,
    {
      headRepo = 'o/r',
      newHead = 'updated-head',
      mergeFails = false,
      updateFails = false,
      ciDispatchFails = false,
    } = {},
  ) => {
    const result = stubbedBash([
      'set -euo pipefail',
      'gh() {',
      `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
      '  case "$*" in',
      `    *"pr view"*headRefOid*) printf '%s\\n' ${JSON.stringify(newHead)} ;;`,
      `    "pr merge"*) ${mergeFails ? 'return 1' : ':'} ;;`,
      `    *update-branch*) ${updateFails ? 'return 1' : ':'} ;;`,
      `    "workflow run"*) ${ciDispatchFails ? 'return 1' : ':'} ;;`,
      '  esac',
      '}',
      'sleep() { :; }',
      'pr=26',
      'repo=o/r',
      'head=old-head',
      `head_repo=${JSON.stringify(headRepo)}`,
      'head_ref=feature',
      `merge_state=${JSON.stringify(mergeState)}`,
      'for _ in 1; do',
      dedent(dispatchBlock, 12),
      'done',
      `printf 'SKIPPED\\n' >> "$GH_LOG"`,
    ]);
    return {
      status: result.status,
      merged: result.calls.includes('gh pr merge'),
      updatedBranch: result.calls.includes('update-branch'),
      dispatchedCi: result.calls.includes('workflow run ci.yml'),
      skipped: result.calls.includes('SKIPPED'),
      warned: (result.stdout + result.stderr).includes('::warning::'),
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
        updatedBranch: result.updatedBranch,
        dispatchedCi: result.dispatchedCi,
        skipped: result.skipped,
        warned: result.warned,
      },
      { status: 0, merged: true, updatedBranch: false, dispatchedCi: false, skipped: false, warned: false },
      `${mergeState} must proceed to merge`,
    );
    // 이 저장소는 auto-merge가 꺼져 있으므로 즉시 병합이고, head 고정은 서버가 한다.
    assert.match(result.calls, /gh pr merge --squash 26 --repo o\/r --match-head-commit old-head/);
  }
  // base 갱신이 필요한 상태는 update-branch 후 CI를 명시 dispatch한다.
  const behind = runDispatch('BEHIND');
  assert.equal(behind.status, 0);
  assert.equal(behind.merged, false);
  assert.equal(behind.updatedBranch, true);
  assert.equal(behind.dispatchedCi, true);
  // update-branch는 비동기라 bounded wait 안에 head가 안 바뀔 수 있다. 계약 위반이
  // 아니라 대기 상태이므로 stale ref로 CI를 쏘지 않고 실패하지도 않는다.
  const behindPending = runDispatch('BEHIND', { newHead: 'old-head' });
  assert.equal(behindPending.status, 0);
  assert.equal(behindPending.updatedBranch, true);
  assert.equal(behindPending.dispatchedCi, false);
  // 병합할 수 없는 상태는 전부 "이 후보만 건너뛴다"로 수렴한다. 실행을 실패시키면
  // 그 실패 check가 PR을 UNSTABLE로 만들고 큐 전체가 뒤의 후보까지 굶긴다.
  for (const mergeState of ['BLOCKED', 'UNKNOWN']) {
    const result = runDispatch(mergeState);
    assert.equal(result.status, 0, `${mergeState} must not fail the run`);
    assert.equal(result.merged, false);
    assert.equal(result.skipped, true, `${mergeState} must skip to the next candidate`);
    assert.equal(result.warned, false);
  }
  // 사람이 봐야 하는 상태는 건너뛰되 신호를 남긴다. 실행은 실패시키지 않는다.
  for (const mergeState of ['DIRTY', 'SOME_NEW_STATE']) {
    const result = runDispatch(mergeState);
    assert.equal(result.status, 0, `${mergeState} must not fail the run`);
    assert.equal(result.merged, false);
    assert.equal(result.skipped, true);
    assert.equal(result.warned, true, `${mergeState} must skip with an operator-visible warning`);
  }
  // 병합·base 갱신 API 호출 실패도 다른 상태와 같게 다룬다. 판정 이후의 head 변경·
  // ruleset 거부·일시적 오류는 전부 "다음 트리거에서 다시 판정"으로 수렴하며, 여기서
  // 실행을 죽이면 그 실패 check가 다음 판정 입력을 오염시킨다.
  const mergeFailed = runDispatch('CLEAN', { mergeFails: true });
  assert.equal(mergeFailed.status, 0, 'merge call failure must not fail the run');
  assert.equal(mergeFailed.warned, true, 'merge call failure must stay operator-visible');
  const updateFailed = runDispatch('BEHIND', { updateFails: true });
  assert.equal(updateFailed.status, 0, 'update-branch failure must not fail the run');
  assert.equal(updateFailed.warned, true, 'update-branch failure must stay operator-visible');
  assert.equal(updateFailed.dispatchedCi, false, '갱신에 실패했으면 CI를 쏘지 않는다');

  // CI dispatch 호출 실패도 같다. base는 이미 갱신됐고 다음 트리거가 다시 판정한다.
  const ciDispatchFailed = runDispatch('BEHIND', { ciDispatchFails: true });
  assert.equal(ciDispatchFailed.status, 0, 'CI dispatch failure must not fail the run');
  assert.equal(ciDispatchFailed.warned, true, 'CI dispatch failure must stay operator-visible');

  // fork head에 base 저장소 CI를 dispatch하지 않는다. 거부하되 큐는 계속 진행한다.
  const fork = runDispatch('BEHIND', { headRepo: 'fork/r' });
  assert.equal(fork.status, 0);
  assert.equal(fork.updatedBranch, false);
  assert.equal(fork.dispatchedCi, false);
  assert.equal(fork.skipped, true);
  assert.equal(fork.warned, true);
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
  (prs, { runNumber = 0, window = null, offset = null, remaining = [5000] } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'automerge-queue-loop-'));
  const log = join(dir, 'gh.log');
  // 잔량은 호출 순서대로 소비하고 목록이 끝나면 마지막 값을 반복한다. 루프 안 재확인이
  // 실제로 다시 읽는지 보려면 실행 도중 값이 바뀌어야 한다.
  writeFileSync(join(dir, 'rates'), `${remaining.join('\n')}\n`);
  for (const pr of prs) {
    const head = `head${pr.number}`;
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
      join(dir, `reviews-${pr.number}.json`),
      JSON.stringify(
        pr.reviewed === false
          ? [[]]
          : [[
              {
                id: 1,
                state: 'APPROVED',
                submitted_at: '2026-08-01T00:00:00Z',
                commit_id: head,
                author_association: 'OWNER',
                body: '',
                user: { login: 'reviewer' },
              },
            ]],
      ),
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
      JSON.stringify([
        {
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
        },
      ]),
    );
    writeFileSync(join(dir, `statuses-${head}.json`), JSON.stringify([[]]));
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
    // BEHIND 경로의 bounded wait는 같은 `gh pr view`를 `--json headRefOid`로 부른다.
    // 두 호출을 한 패턴으로 잡으면 new_head에 JSON 문서 전체가 들어가고, 테스트가
    // 잘못된 이유로 통과한다. 좁은 패턴을 먼저 둔다.
    '    "pr view "*"--json headRefOid"*) set -- $all; jq -r ".headRefOid" "$FIX/pr-$3.json" ;;',
    '    "pr view "*) set -- $all; cat "$FIX/pr-$3.json" ;;',
    '    *pulls/*/reviews*) n="${all#*pulls/}"; n="${n%%/reviews*}"; cat "$FIX/reviews-$n.json" ;;',
    '    *graphql*) n="${all#*number=}"; n="${n%% *}"; cat "$FIX/threads-$n.json" ;;',
    '    *check-runs*) h="${all#*commits/}"; h="${h%%/check-runs*}"; cat "$FIX/checks-$h.json" ;;',
    '    *statuses*) h="${all#*commits/}"; h="${h%%/statuses*}"; cat "$FIX/statuses-$h.json" ;;',
    // 응답이 필요 없는 실제 동작. 로그에만 남기고 조용히 성공한다.
    '    "pr merge"* | *update-branch* | "workflow run"*) ;;',
    // 기본 분기가 없으면 워크플로가 새 gh 호출을 늘렸을 때 스텁이 빈 출력 + 종료 코드 0을
    // 낸다. 큐 루프는 그것을 "빈 API 응답"으로 읽고 후보를 건너뛰므로, 하네스가 덮지 못한
    // 호출이 조용히 통과한다. 실패시켜 즉시 드러낸다.
    `    *) printf 'unstubbed gh call: %s\\n' "$all" >&2; return 1 ;;`,
    '  esac',
    '}',
    'sleep() { :; }',
    'repo=o/r',
    'owner=o',
    'name=r',
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
    // 후보 평가 1건당 1회만 세야 한다. bounded wait의 headRefOid 조회까지 세면 같은
    // 후보가 두 번 잡혀 "실행당 실제 동작 최대 한 건" 계약이 헐거워진다.
    evaluated: [...calls.matchAll(/gh pr view (\d+) --repo [^\n]*--json baseRefName/g)].map((m) =>
      Number(m[1]),
    ),
    updatedBranch: calls.includes('update-branch'),
    dispatchedCi: calls.includes('workflow run ci.yml'),
    rateCalls: (calls.match(/gh api rate_limit/g) ?? []).length,
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
  // base 갱신도 실제 동작이므로 같은 규칙을 따른다. 픽스처의 head는 갱신 뒤에도 그대로라
  // bounded wait가 대기로 끝나야 하고, stale ref로 CI를 쏘면 안 된다.
  const behind = runQueue([
    { number: 1, mergeStateStatus: 'BEHIND' },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ]);
  assert.equal(behind.status, 0);
  assert.equal(behind.mergedPr, null);
  assert.deepEqual(behind.evaluated, [1], 'base 갱신도 한 실행에 한 건이다');
  assert.equal(behind.updatedBranch, true);
  assert.equal(behind.dispatchedCi, false, 'stale ref에 CI를 dispatch하면 안 된다');
  // 아무 후보도 병합할 수 없으면 병합 없이 성공으로 끝난다. 라벨은 건드리지 않는다.
  const allBlocked = runQueue([
    { number: 1, mergeStateStatus: 'BLOCKED' },
    { number: 2, mergeStateStatus: 'DIRTY' },
  ]);
  assert.equal(allBlocked.status, 0);
  assert.equal(allBlocked.mergedPr, null);
  assert.equal(allBlocked.evaluated.length, 2);
});

test('후보 창은 API 지분·timeout·실측 큐 깊이 세 기준으로 유도되고 모든 후보에 도달한다', async () => {
  const workflow = await readWorkflow();

  // 창 크기는 이 저장소 값으로 다시 계산해야 한다. 형제 저장소 상수(backend 6, mobile 20)를
  // 그대로 쓰면 실행당 청구가 이 저장소가 허용하기로 한 지분을 넘는다.
  const declaredWindow = declaredWindowOf(workflow);
  assert.equal(declaredWindow, 5, 'window ceiling must stay pinned to the derived value');
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
  assert.equal(windowMax, 5);
  // 이 저장소에는 큐가 지켜 줘야 할 producer 체인이 없다. 예약분은 큐가 자기 다음 실행과
  // 운영자 조회 몫까지 태우지 않게 하는 하한이다(실행당 고정 비용 17회 * 최소 11회 실행분).
  assert.equal(reserve, 200, 'shared-limit reserve must stay pinned');
  assert.equal(fixedCost, 15);
  // 후보당 청구는 호출 5회가 아니라 --paginate 추가 페이지까지 덮는 여유값이다.
  assert.equal(perCandidate, 9, 'per-candidate charge must keep the pagination allowance');

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
    [5000, 5],
    [1000, 5],
    [260, 5],
    [259, 4],
    [242, 3],
    [224, 1],
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
  assert.equal(runPayload(buckets(5000, 242)).stdout.trim(), 'window=3');
  assert.equal(runPayload(buckets(242, 5000)).stdout.trim(), 'window=3');

  // 예약분에 닿으면 큐만 건너뛴다. 실행을 실패시키지 않는다 — 실패로 남기면 그 check가
  // 다음 판정 입력을 오염시킨다.
  for (const remaining of [223, 220, 200, 0]) {
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
  const drained = runQueue(queue, { remaining: [5000, 210] });
  assert.equal(drained.status, 0, 'reserve stop must not fail the run');
  assert.deepEqual(drained.evaluated, [], 'no candidate may be evaluated below the reserve');
  assert.equal(drained.mergedPr, null);
  assert.match(drained.stdout + drained.stderr, /::warning::/);

  // 한 건을 평가한 뒤 바닥나면 거기서 멈춘다. 뒤의 병합 가능 후보는 다음 실행 몫이다.
  const midway = runQueue(queue, { remaining: [5000, 5000, 210] });
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

  for (const [name, workflow] of files) {
    const blocks = runBlocks(workflow);
    assert.ok(blocks.length > 0, `${name}: run 블록 추출이 비었다`);

    for (const block of blocks) {
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

test('BEHIND 경로의 CI 재부착이 명시 dispatch로 성립한다', async () => {
  const ciWorkflow = await readFile(ciWorkflowUrl, 'utf8');

  // GITHUB_TOKEN의 update-branch push는 synchronize를 만들지 못한다. 새 head에 required
  // context를 붙이는 유일한 경로가 dispatch다.
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

  // 코디네이터가 만드는 명시 dispatch는 PR CI 하나뿐이어야 한다. producer dispatch를
  // 몰래 늘리면 판정 근거(위 실측)와 어긋난다.
  const workflow = await readWorkflow();
  const dispatches = [...workflow.matchAll(/gh workflow run ([^\s]+)/g)].map((match) => match[1]);
  assert.deepEqual(dispatches, ['ci.yml']);
  // 판정 근거는 주석으로 남아 있어야 한다. 근거 없이 값만 남으면 다음 사람이 되돌린다.
  for (const basis of ['cd.yml', 'sensitive-backup-retention.yml', '병합 후 실행되어야 하는 producer는 없다']) {
    assert.ok(workflow.includes(basis), `producer 판정 근거 누락: ${basis}`);
  }
});
