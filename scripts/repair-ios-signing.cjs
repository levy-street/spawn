#!/usr/bin/env node
// Scoped recovery for the confirmed missing-certificate incident.
// EAS private APIs are deliberately pinned; upgrades need another source review.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const SCOPE = Object.freeze({
  projectId: '8f87ab3b-1f34-4d2b-b1b3-653511c070a0',
  account: 'trevcavill', slug: 'spawn', bundle: 'dev.spawnd',
  team: '9RT4S4TGA3', profile: '2D3KV7W353',
  missingSerial: '7A832823DD0BC96E0EC0DD073BBB0BB',
  easVersion: '24.7.0',
  appleUtilsVersion: '2.2.1',
});
class Refusal extends Error {}
function requireThat(condition, message) {
  if (!condition) throw new Refusal(message);
}
function certificateInScope(certificate) {
  return certificate?.appleTeam?.appleTeamIdentifier === SCOPE.team;
}
function certificateUsable(certificate, validSerials, now) {
  return certificateInScope(certificate) &&
    validSerials.includes(certificate.serialNumber) &&
    Date.parse(certificate.validityNotBefore) <= now &&
    Date.parse(certificate.validityNotAfter) > now &&
    !!certificate.certificateP12 && !!certificate.certificatePassword;
}

// The adapter owns secrets. Only these explicit fields may reach the report.
async function recover(adapter, { apply = false, clock = Date.now } = {}) {
  const scope = await adapter.scope();
  requireThat(scope.projectId === SCOPE.projectId && scope.account === SCOPE.account &&
    scope.slug === SCOPE.slug && scope.bundle === SCOPE.bundle && scope.team === SCOPE.team,
  'Unexpected app, account, bundle, or Apple team; no credential changes allowed.');
  const before = await adapter.credentials();
  const oldCertificate = before?.distributionCertificate;
  const profile = before?.provisioningProfile;
  requireThat(certificateInScope(oldCertificate), 'The current certificate has an unexpected Apple team.');
  requireThat(profile?.appleTeam?.appleTeamIdentifier === SCOPE.team,
    'The current profile has an unexpected Apple team.');
  const validSerials = await adapter.validSerials();
  const currentValid = certificateUsable(oldCertificate, validSerials, clock());
  const profileValid = await adapter.validate(before);
  const report = {
    projectId: SCOPE.projectId, bundle: SCOPE.bundle, team: SCOPE.team,
    certificateSerial: oldCertificate.serialNumber,
    profileId: profile.developerPortalIdentifier,
    certificateValid: currentValid, profileValid, changed: false,
  };
  if (currentValid && profileValid) return { ...report, result: 'already-valid' };
  requireThat(oldCertificate.serialNumber === SCOPE.missingSerial &&
    !validSerials.includes(oldCertificate.serialNumber) &&
    profile.developerPortalIdentifier === SCOPE.profile,
  'Signing failure differs from the confirmed missing-certificate incident.');
  requireThat(await adapter.profileExists(profile),
    'The original app profile no longer exists; this repair will not replace it.');
  const candidates = (await adapter.certificates()).filter(cert =>
    certificateUsable(cert, validSerials, clock()));
  candidates.sort((a, b) => Date.parse(b.validityNotAfter) - Date.parse(a.validityNotAfter));
  const action = candidates.length ? 'reuse-valid-certificate' : 'create-certificate';
  if (!apply) return { ...report, result: 'repair-needed', action };
  // A second fetch fences concurrent changes before the first mutation.
  const current = await adapter.credentials();
  requireThat(current?.id === before.id &&
    current.distributionCertificate?.id === oldCertificate.id &&
    current.provisioningProfile?.id === profile.id &&
    current.distributionCertificate?.serialNumber === oldCertificate.serialNumber &&
    current.provisioningProfile?.developerPortalIdentifier === profile.developerPortalIdentifier,
  'The app credentials changed while inspecting them; retry inspection.');
  const certificate = candidates[0] ?? await adapter.createCertificate();
  requireThat(certificateUsable(certificate, await adapter.validSerials(), clock()),
    'Replacement certificate did not pass live Apple validation.');
  // The ASC regeneration helper can delete the original profile internally.
  // Create a separate named profile and change only this app's association.
  const repaired = await adapter.createAndAssignProfile(certificate);
  requireThat(repaired, 'The new app provisioning profile could not be assigned.');
  const after = await adapter.credentials();
  requireThat(after?.distributionCertificate?.id === certificate.id &&
    after.provisioningProfile?.id === repaired.provisioningProfile?.id &&
    after.provisioningProfile?.id !== profile.id &&
    !!after.provisioningProfile?.developerPortalIdentifier &&
    after.provisioningProfile?.developerPortalIdentifier !== profile.developerPortalIdentifier &&
    await adapter.profileExists(profile) &&
    certificateUsable(after.distributionCertificate, await adapter.validSerials(), clock()) &&
    await adapter.validate(after),
  'Post-repair app credential verification failed.');
  return { ...report, previousProfileId: report.profileId,
    profileId: after.provisioningProfile.developerPortalIdentifier, previousProfilePreserved: true,
    certificateSerial: certificate.serialNumber, certificateValid: true,
    profileValid: true, changed: true, result: 'repaired', action };
}

function runtimeGuard(env, mode) {
  requireThat(['inspect', 'repair'].includes(mode), 'Use inspect or repair.');
  requireThat(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'levy-street/spawn' &&
    env.GITHUB_REF === 'refs/heads/master', 'Only the protected master workflow may run this helper.');
  requireThat(!!env.EXPO_TOKEN, 'The production Expo token is unavailable.');
  requireThat(!env.EXPO_API_HOST && !env.EXPO_STAGING && !env.EXPO_LOCAL,
    'Alternate Expo API endpoints are not allowed.');
}

async function makeAdapter(easRoot, mobileDir) {
  const sdk = createRequire(path.join(easRoot, 'package.json'));
  requireThat(sdk('./package.json').version === SCOPE.easVersion, 'Unexpected EAS CLI version.');
  requireThat(sdk('@expo/apple-utils/package.json').version === SCOPE.appleUtilsVersion,
    'Unexpected Apple SDK version; credential recovery needs another source review.');
  const exp = JSON.parse(fs.readFileSync(path.join(mobileDir, 'app.json'), 'utf8')).expo;
  requireThat(exp.extra?.eas?.projectId === SCOPE.projectId && exp.slug === SCOPE.slug &&
    exp.ios?.bundleIdentifier === SCOPE.bundle, 'Unexpected mobile project identity.');
  const { createGraphqlClient } = sdk('./build/commandUtils/context/contextUtils/createGraphqlClient');
  const { AppQuery } = sdk('./build/graphql/queries/AppQuery');
  const { CredentialsContext } = sdk('./build/credentials/context');
  const { resolveAscApiKeyForAppCredentialsAsync } = sdk('./build/credentials/ios/actions/AscApiKeyUtils');
  const { AuthenticationMode, AppleTeamType } = sdk('./build/credentials/ios/appstore/authenticateTypes');
  const { IosDistributionType } = sdk('./build/graphql/generated');
  const { getBuildCredentialsAsync } = sdk('./build/credentials/ios/actions/BuildCredentialsUtils');
  const { validateProvisioningProfileAsync } = sdk('./build/credentials/ios/validators/validateProvisioningProfile');
  const { CreateDistributionCertificate } = sdk('./build/credentials/ios/actions/CreateDistributionCertificate');
  const { SetUpProvisioningProfile } = sdk('./build/credentials/ios/actions/SetUpProvisioningProfile');
  const { getValidCertSerialNumbers } = sdk('./build/credentials/ios/appstore/CredentialsUtils');
  const { getApplePlatformFromTarget } = sdk('./build/project/ios/target');
  const graphqlClient = createGraphqlClient({ accessToken: process.env.EXPO_TOKEN, sessionSecret: null });
  const project = await AppQuery.byIdAsync(graphqlClient, SCOPE.projectId);
  requireThat(project.id === SCOPE.projectId && project.ownerAccount?.name === SCOPE.account &&
    project.fullName === `@${SCOPE.account}/${SCOPE.slug}`, 'Remote EAS project identity mismatch.');
  const app = { account: project.ownerAccount, projectName: SCOPE.slug, bundleIdentifier: SCOPE.bundle };
  const target = { targetName: 'SPAWND', bundleIdentifier: SCOPE.bundle, buildSettings: { SDKROOT: 'iphoneos' } };
  const ctx = new CredentialsContext({ projectDir: mobileDir, projectInfo: { exp, projectId: SCOPE.projectId },
    graphqlClient, nonInteractive: true, autoAcceptCredentialReuse: true });
  const key = await resolveAscApiKeyForAppCredentialsAsync({ graphqlClient, app });
  requireThat(key?.teamId === SCOPE.team, 'The stored App Store Connect key has an unexpected team.');
  await ctx.appStore.ensureAuthenticatedAsync({ mode: AuthenticationMode.API_KEY, ascApiKey: key.ascApiKey,
    teamId: SCOPE.team, teamName: key.teamName, teamType: AppleTeamType.COMPANY_OR_ORGANIZATION });
  requireThat(ctx.appStore.authCtx?.team.id === SCOPE.team, 'Apple authenticated a different team.');
  // Reject direct destructive calls as defense in depth. Nested SDK calls are
  // not intercepted: the pinned create-only call path was reviewed separately.
  const denyDestructive = object => new Proxy(object, { get(targetObject, property, receiver) {
    if (typeof property === 'string' && /delete|revoke/i.test(property)) {
      return () => { throw new Refusal('Credential deletion and revocation are prohibited.'); };
    }
    return Reflect.get(targetObject, property, receiver);
  } });
  ctx.ios = denyDestructive(ctx.ios);
  ctx.appStore = denyDestructive(ctx.appStore);
  const distribution = IosDistributionType.AppStore;
  const profiles = () => ctx.appStore.listProvisioningProfilesAsync(SCOPE.bundle, getApplePlatformFromTarget(target));
  return {
    scope: async () => ({ projectId: project.id, account: app.account.name, slug: app.projectName,
      bundle: app.bundleIdentifier, team: ctx.appStore.authCtx.team.id }),
    // Network-only avoids accepting a cached pre-mutation credential response.
    credentials: () => getBuildCredentialsAsync({ ...ctx,
      graphqlClient: { ...graphqlClient, query: (query, variables, options) =>
        graphqlClient.query(query, variables, { ...options, requestPolicy: 'network-only' }) },
    }, app, distribution),
    validSerials: async () => getValidCertSerialNumbers(await ctx.appStore.listDistributionCertificatesAsync()),
    validate: credentials => validateProvisioningProfileAsync(ctx, target, app, credentials),
    profileExists: async profile => (await profiles()).some(value =>
      value.provisioningProfileId === profile.developerPortalIdentifier),
    certificates: () => ctx.ios.getDistributionCertificatesForAccountAsync(graphqlClient, app.account),
    createCertificate: () => new CreateDistributionCertificate(app.account).runAsync(ctx),
    createAndAssignProfile: certificate =>
      new SetUpProvisioningProfile(app, target, distribution).createAndAssignProfileAsync(ctx, certificate),
  };
}

async function main() {
  const [mode, easRoot, mobileDir] = process.argv.slice(2);
  runtimeGuard(process.env, mode);
  requireThat(easRoot && mobileDir && process.argv.length === 5, 'Expected mode, EAS CLI directory, mobile directory.');
  // SDK errors may contain request bodies. Keep all SDK output out of job logs;
  // publish only our allowlisted report and fixed failure messages.
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const discard = (_chunk, encoding, callback) => {
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  process.stdout.write = discard;
  process.stderr.write = discard;
  let stage = 'inspect';
  try {
    const adapter = await makeAdapter(path.resolve(easRoot), path.resolve(mobileDir));
    stage = mode;
    const report = await recover(adapter, { apply: mode === 'repair' });
    stdout(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    stderr(`${error instanceof Refusal ? error.message : `Signing recovery failed during ${stage}; SDK error details withheld.`}\n`);
    process.exitCode = 1;
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}
module.exports = { SCOPE, Refusal, recover, runtimeGuard, makeAdapter };
if (require.main === module) main().catch(error => {
  process.stderr.write(`${error instanceof Refusal ? error.message : 'Signing recovery failed before authentication.'}\n`);
  process.exitCode = 1;
});
