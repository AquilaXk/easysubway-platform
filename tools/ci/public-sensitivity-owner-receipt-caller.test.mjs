import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const callerUrl = new URL(
  '../../.github/workflows/public-sensitivity-owner-receipt-caller.yml',
  import.meta.url,
);
const ciWorkflowUrl = new URL('../../.github/workflows/ci.yml', import.meta.url);
const commonWorkflow =
  'AquilaXk/easysubway/.github/workflows/public-sensitivity-owner-receipt.yml@3d1590baa98c929ceabd0d2d44414cebcc643c6f';

test('public sensitivity owner receipt caller is a least-privilege immutable reusable-workflow call', async () => {
  const caller = await readFile(callerUrl, 'utf8');
  const codeLines = caller.split('\n').filter((line) => !/^\s*#/.test(line));
  const code = codeLines.join('\n');

  assert.match(code, /^name: Public Sensitivity Owner Receipt Caller$/m);
  assert.match(code, /^on:\n  workflow_dispatch:\n\npermissions:/m);
  assert.match(code, /^permissions:\n  contents: read\n  actions: read\n\njobs:/m);

  const jobs = code.match(/^jobs:\n([\s\S]*)$/m)?.[1];
  assert.ok(jobs, 'caller must declare jobs');
  assert.deepEqual(
    [...jobs.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((match) => match[1]),
    ['receipt'],
  );
  assert.equal((jobs.match(/^    uses:/gm) ?? []).length, 1, 'caller must invoke one reusable workflow');
  assert.match(jobs, new RegExp(`^    uses: ${commonWorkflow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(
    jobs,
    /^    secrets:\n      D20_SECRET_SCANNING_ALERTS_READ_TOKEN: \$\{\{ secrets\.D20_SECRET_SCANNING_ALERTS_READ_TOKEN \}\}\s*$/m,
  );
  assert.equal(
    (jobs.match(/^      [\w-]+:/gm) ?? []).length,
    1,
    'caller must map only the required token',
  );

  assert.doesNotMatch(code, /secrets:\s*inherit/);
  assert.doesNotMatch(jobs, /^ {4}(?:runs-on|steps|permissions|with):/m);
  assert.doesNotMatch(code, /self-hosted|\brun:/);
  assert.doesNotMatch(code, /actions:\s*write|contents:\s*write|permissions:\s*\{/);
  assert.doesNotMatch(code, /public-sensitivity-owner-receipt\.yml@(?!3d1590baa98c929ceabd0d2d44414cebcc643c6f)/);
});

test('Platform CI discovers the focused caller contract test explicitly', async () => {
  const ciWorkflow = await readFile(ciWorkflowUrl, 'utf8');
  assert.match(
    ciWorkflow,
    /          node --test tools\/ci\/public-sensitivity-owner-receipt-caller\.test\.mjs/,
  );
  assert.equal(
    (ciWorkflow.match(/node --test tools\/ci\/public-sensitivity-owner-receipt-caller\.test\.mjs/g) ?? []).length,
    1,
  );
});
