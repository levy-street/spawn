'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SCOPE } = require('./repair-ios-signing.cjs');
const { decide, summary } = require('./recover-mobile-stores.cjs');
const candidate = 'a'.repeat(40);
const id = '11111111-1111-1111-1111-111111111111';
const fixture = (patch = {}) => ({ id, app: { id: SCOPE.projectId, slug: SCOPE.slug,
  ownerAccount: { name: SCOPE.account } }, platform: 'IOS', gitCommitHash: candidate,
  distribution: 'STORE', buildProfile: 'production', appIdentifier: SCOPE.bundle,
  updateChannel: { name: 'production' }, status: 'FINISHED', submissions: [], ...patch });

test('never duplicates a finished, active, or unknown-state candidate build', () => {
  for (const status of ['FINISHED', 'NEW', 'IN_QUEUE', 'IN_PROGRESS', 'PENDING_CANCEL', 'UNKNOWN']) {
    assert.throws(() => decide('build-ios', [fixture({ status })], candidate), /already exists/);
  }
  for (const status of ['ERRORED', 'CANCELED']) {
    const command = decide('build-ios', [fixture({ status })], candidate);
    assert.ok(command.includes('--freeze-credentials'));
    assert.ok(command.includes('--auto-submit'));
    assert.equal(command[command.indexOf('--platform') + 1], 'ios');
  }
});
test('platforms are independent after partial all-platform setup failure', () => {
  const android = fixture({ platform: 'ANDROID', status: 'IN_PROGRESS' });
  assert.throws(() => decide('build-android', [android], candidate), /already exists/);
  assert.equal(decide('build-ios', [android], candidate)[0], 'build');
});
test('submission requires the exact finished candidate build', () => {
  assert.equal(decide('submit-ios', [fixture()], candidate, id)[0], 'submit');
  for (const patch of [{ status: 'IN_PROGRESS' }, { gitCommitHash: 'b'.repeat(40) },
    { app: { id: 'other' } }, { distribution: 'INTERNAL' }, { buildProfile: 'preview' },
    { appIdentifier: 'other.app' }, { updateChannel: { name: 'preview' } }, { isForIosSimulator: true }]) {
    assert.throws(() => decide('submit-ios', [fixture(patch)], candidate, id));
  }
  assert.throws(() => decide('submit-ios', [fixture()], candidate, ''), /UUID/);
  assert.throws(() => decide('submit-ios', [fixture()], candidate, '22222222-2222-2222-2222-222222222222'), /not finished/);
});
test('successful and pending submissions are never duplicated', () => {
  for (const status of ['FINISHED', 'IN_PROGRESS', 'AWAITING_BUILD', 'IN_QUEUE', 'UNKNOWN']) {
    assert.throws(() => decide('submit-ios', [fixture({ submissions: [{ status }] })], candidate, id), /already exists/);
  }
  for (const status of ['ERRORED', 'CANCELED']) {
    assert.equal(decide('submit-ios', [fixture({ submissions: [{ status }] })], candidate, id)[0], 'submit');
  }
});
test('inspection and unknown operations cannot silently submit', () => {
  assert.equal(decide('inspect', [fixture()], candidate), null);
  assert.throws(() => decide('inspect', [], candidate, id), /only valid/);
  assert.throws(() => decide('shell-command', [], candidate), /Unknown/);
});
test('reports exclude credentials, artifact URLs, private logs and arbitrary errors', () => {
  const report = summary(fixture({ artifacts: { buildUrl: 'PRIVATE' }, logFiles: ['PRIVATE'],
    error: { errorCode: 'CODE', message: 'PRIVATE' }, submissions: [{ id, platform: 'IOS', status: 'ERRORED',
      logFiles: ['PRIVATE'], error: { message: 'PRIVATE', errorCode: 'SUBMIT_CODE' },
      iosConfig: { ascAppIdentifier: '6804522108', appleIdUsername: 'PRIVATE' } }] }));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  assert.equal(report.submissions[0].errorCode, 'SUBMIT_CODE');
});
