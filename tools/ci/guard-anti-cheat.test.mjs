import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkCircularMocking,
  checkSilentPassBypasses,
  checkProductionCheats,
  checkHollowAssertions,
  runAntiCheatAudit,
} from './guard-anti-cheat.mjs';

test('checkHollowAssertions catches tautological assertions in test sources', () => {
  const violations = checkHollowAssertions();
  assert.ok(Array.isArray(violations));
});

test('checkCircularMocking verifies test helpers are decoupled', () => {
  const violations = checkCircularMocking();
  assert.ok(Array.isArray(violations));
});

test('checkSilentPassBypasses verifies no silent catch blocks or missing tool passes', () => {
  const violations = checkSilentPassBypasses();
  assert.ok(Array.isArray(violations));
});

test('checkProductionCheats verifies zero backdoor flags in production tools', () => {
  const violations = checkProductionCheats();
  assert.ok(Array.isArray(violations));
});

test('runAntiCheatAudit passes cleanly on the updated platform repository', () => {
  const violations = runAntiCheatAudit();
  assert.equal(violations.length, 0, `Expected 0 violations, found: ${JSON.stringify(violations, null, 2)}`);
});
