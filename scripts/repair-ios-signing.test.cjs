'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SCOPE, recover, runtimeGuard } = require('./repair-ios-signing.cjs');
const now = Date.parse('2026-09-20T13:00:00Z');
const certificate = (id, extra = {}) => ({
  id, serialNumber: id, appleTeam: { appleTeamIdentifier: SCOPE.team },
  validityNotBefore: '2026-08-01T00:00:00Z', validityNotAfter: '2027-08-01T00:00:00Z',
  certificateP12: 'PRIVATE-P12', certificatePassword: 'PRIVATE-PASSWORD', ...extra,
});
function fixture({ healthy = false, certificates = [certificate('valid')], valid = ['valid'] } = {}) {
  const writes = [];
  let current = { id: 'build', distributionCertificate: certificate(healthy ? 'valid' : SCOPE.missingSerial),
    provisioningProfile: { id: 'profile', developerPortalIdentifier: SCOPE.profile,
      appleTeam: { appleTeamIdentifier: SCOPE.team }, provisioningProfile: 'PRIVATE-PROFILE' } };
  const adapter = {
    scope: async () => ({ projectId: SCOPE.projectId, account: SCOPE.account,
      slug: SCOPE.slug, bundle: SCOPE.bundle, team: SCOPE.team }),
    credentials: async () => structuredClone(current),
    validSerials: async () => valid,
    validate: async credentials => credentials.distributionCertificate.serialNumber !== SCOPE.missingSerial,
    profileExists: async () => true,
    certificates: async () => certificates,
    createCertificate: async () => { writes.push('create'); valid.push('created'); return certificate('created'); },
    createAndAssignProfile: async cert => {
      writes.push(['assign-new-profile', cert.id]);
      current = { ...current, distributionCertificate: cert, provisioningProfile: {
        ...current.provisioningProfile, id: 'new-profile', developerPortalIdentifier: 'NEW-PROFILE',
      } };
      return current;
    },
  };
  return { adapter, writes };
}
const options = { apply: true, clock: () => now };

test('already valid credentials remain unchanged even when repair requested', async () => {
  const { adapter, writes } = fixture({ healthy: true });
  const report = await recover(adapter, options);
  assert.equal(report.result, 'already-valid');
  assert.deepEqual(writes, []);
});
test('inspection does not mutate missing-certificate state or disclose secrets', async () => {
  const { adapter, writes } = fixture();
  const report = await recover(adapter, { clock: () => now });
  assert.equal(report.result, 'repair-needed');
  assert.equal(report.action, 'reuse-valid-certificate');
  assert.deepEqual(writes, []);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|password|certificateP12|provisioningProfile/);
});
test('repair reuses existing valid certificate and preserves the old profile', async () => {
  const { adapter, writes } = fixture();
  const report = await recover(adapter, options);
  assert.equal(report.result, 'repaired');
  assert.deepEqual(writes, [['assign-new-profile', 'valid']]);
  assert.equal(report.previousProfileId, SCOPE.profile);
  assert.equal(report.profileId, 'NEW-PROFILE');
  assert.equal(report.previousProfilePreserved, true);
});
test('creates only when no reusable certificate is valid on the correct team', async () => {
  const { adapter, writes } = fixture({ certificates: [certificate('other-team', {
    appleTeam: { appleTeamIdentifier: 'OTHER' },
  }), certificate('expired', { validityNotAfter: '2026-01-01T00:00:00Z' })], valid: ['other-team', 'expired'] });
  const report = await recover(adapter, options);
  assert.equal(report.action, 'create-certificate');
  assert.deepEqual(writes, ['create', ['assign-new-profile', 'created']]);
});
test('certificate capacity failure cannot reach a profile mutation or a revocation', async () => {
  const { adapter, writes } = fixture({ certificates: [], valid: [] });
  adapter.createCertificate = async () => { throw new Error('capacity'); };
  await assert.rejects(recover(adapter, options), /capacity/);
  assert.deepEqual(writes, []);
});
test('wrong app, account, bundle, or team fail before any mutation', async () => {
  for (const field of ['projectId', 'account', 'slug', 'bundle', 'team']) {
    const { adapter, writes } = fixture();
    const scope = await adapter.scope();
    adapter.scope = async () => ({ ...scope, [field]: 'wrong' });
    await assert.rejects(recover(adapter, options), /Unexpected app/);
    assert.deepEqual(writes, []);
  }
});
test('different incident and missing original profile are refused', async () => {
  for (const kind of ['serial', 'profile', 'missing']) {
    const { adapter, writes } = fixture();
    const original = adapter.credentials;
    adapter.credentials = async () => {
      const value = await original();
      if (kind === 'serial') value.distributionCertificate.serialNumber = 'another-old-certificate';
      if (kind === 'profile') value.provisioningProfile.developerPortalIdentifier = 'another-profile';
      return value;
    };
    if (kind === 'missing') adapter.profileExists = async () => false;
    await assert.rejects(recover(adapter, options), /differs|no longer exists/);
    assert.deepEqual(writes, []);
  }
});
test('concurrent credential reassignment is fenced before mutation', async () => {
  const { adapter, writes } = fixture();
  const original = adapter.credentials;
  let reads = 0;
  adapter.credentials = async () => {
    const value = await original();
    if (++reads > 1) value.distributionCertificate.id = 'changed';
    return value;
  };
  await assert.rejects(recover(adapter, options), /changed while inspecting/);
  assert.deepEqual(writes, []);
});
test('failed profile assignment stops without falling back to deletion or retry', async () => {
  const { adapter, writes } = fixture();
  adapter.createAndAssignProfile = async () => null;
  await assert.rejects(recover(adapter, options), /could not be assigned/);
  assert.deepEqual(writes, []);
});
test('stale or failed post-repair verification is an error', async () => {
  const { adapter } = fixture();
  adapter.createAndAssignProfile = async () => true;
  await assert.rejects(recover(adapter, options), /Post-repair/);
});
test('the original Apple profile must still exist after repair', async () => {
  const { adapter } = fixture();
  let reads = 0;
  adapter.profileExists = async () => ++reads === 1;
  await assert.rejects(recover(adapter, options), /Post-repair/);
});
test('runtime refuses other repositories, branches, endpoints, and missing token', () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'levy-street/spawn',
    GITHUB_REF: 'refs/heads/master', EXPO_TOKEN: 'test' };
  runtimeGuard(env, 'inspect');
  for (const patch of [{ GITHUB_ACTIONS: '' }, { GITHUB_REPOSITORY: 'other/spawn' },
    { GITHUB_REF: 'refs/heads/feature' }, { EXPO_TOKEN: '' }, { EXPO_API_HOST: 'https://elsewhere' }]) {
    assert.throws(() => runtimeGuard({ ...env, ...patch }, 'repair'));
  }
});
