#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync, spawnSync } = require('node:child_process');
const signing = require('./repair-ios-signing.cjs');
const { SCOPE, Refusal } = signing;
const operations = ['inspect', 'inspect-ios-signing', 'repair-ios-signing',
  'build-ios', 'build-android', 'submit-ios', 'submit-android'];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const requireThat = (condition, message) => { if (!condition) throw new Refusal(message); };
const failed = status => ['ERRORED', 'CANCELED'].includes(status);

function validateBuild(build, candidate, platform) {
  requireThat(build?.app?.id === SCOPE.projectId &&
    build.app.ownerAccount?.name === SCOPE.account && build.app.slug === SCOPE.slug &&
    build.gitCommitHash === candidate && build.platform === platform.toUpperCase() &&
    build.distribution === 'STORE' && build.buildProfile === 'production' &&
    build.appIdentifier === SCOPE.bundle && build.updateChannel?.name === 'production' &&
    !build.isForIosSimulator && uuid.test(build.id),
  'Build does not match this deployed production app, candidate, and platform.');
}

function decide(operation, records, candidate, buildId = '') {
  requireThat(operations.includes(operation), 'Unknown recovery operation.');
  if (!operation.startsWith('submit-')) requireThat(!buildId, 'Build ID is only valid for submit.');
  if (!operation.startsWith('build-') && !operation.startsWith('submit-')) return null;
  const platform = operation.split('-')[1];
  const builds = records.filter(build => build.platform === platform.toUpperCase());
  for (const build of builds) validateBuild(build, candidate, platform);
  if (operation.startsWith('build-')) {
    requireThat(!builds.some(build => !failed(build.status)),
      'A build already exists or is still active; inspect it before building again.');
    return ['build', '--platform', platform, '--profile', 'production',
      '--non-interactive', '--freeze-credentials', '--auto-submit', '--no-wait'];
  }
  requireThat(uuid.test(buildId), 'Submit requires an explicit build UUID.');
  const build = builds.find(value => value.id === buildId);
  requireThat(build?.status === 'FINISHED', 'The selected candidate build is not finished.');
  requireThat(Array.isArray(build.submissions) &&
    !build.submissions.some(submission => !failed(submission.status)),
  'Submission already exists, is still active, or could not be verified.');
  return ['submit', '--platform', platform, '--profile', 'production', '--id', buildId,
    '--non-interactive', '--no-wait'];
}

function summary(build) {
  // Never emit download/log URLs, request bodies, credentials or arbitrary errors.
  return { id: build.id, platform: build.platform, status: build.status,
    gitCommitHash: build.gitCommitHash, appVersion: build.appVersion,
    appBuildVersion: build.appBuildVersion, runtimeVersion: build.runtime?.version,
    channel: build.updateChannel?.name, errorCode: build.error?.errorCode,
    submissions: build.submissions.map(value => ({ id: value.id, platform: value.platform,
      status: value.status, errorCode: value.error?.errorCode,
      androidTrack: value.androidConfig?.track, iosAppId: value.iosConfig?.ascAppIdentifier })) };
}

async function records(sdk, candidate) {
  const { createGraphqlClient } = sdk('./build/commandUtils/context/contextUtils/createGraphqlClient');
  const { AppQuery } = sdk('./build/graphql/queries/AppQuery');
  const { BuildQuery } = sdk('./build/graphql/queries/BuildQuery');
  const client = createGraphqlClient({ accessToken: process.env.EXPO_TOKEN, sessionSecret: null });
  const app = await AppQuery.byIdAsync(client, SCOPE.projectId);
  requireThat(app.id === SCOPE.projectId && app.fullName === `@${SCOPE.account}/${SCOPE.slug}` &&
    app.ownerAccount?.name === SCOPE.account, 'Unexpected remote Expo project.');
  const result = [];
  for (let offset = 0; offset < 1000; offset += 50) {
    const page = await BuildQuery.viewBuildsOnAppAsync(client, {
      appId: SCOPE.projectId, offset, limit: 50,
      filter: { gitCommitHash: candidate, distribution: 'STORE', buildProfile: 'production' },
    });
    for (const build of page) {
      const detailed = await BuildQuery.withSubmissionsByIdAsync(client, build.id, { useCache: false });
      requireThat(['IOS', 'ANDROID'].includes(detailed.platform), 'Unknown build platform.');
      validateBuild(detailed, candidate, detailed.platform.toLowerCase());
      requireThat(Array.isArray(detailed.submissions), 'Could not inspect build submissions.');
      result.push(detailed);
    }
    if (page.length < 50) return result;
  }
  throw new Refusal('Too many candidate builds to inspect safely.');
}

async function quiet(action) {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const discard = (_chunk, encoding, callback) => {
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  process.stdout.write = discard;
  process.stderr.write = discard;
  try { return await action(); } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

async function main() {
  const [operation, easRootArg, mobileArg, candidate, buildId = ''] = process.argv.slice(2);
  signing.runtimeGuard(process.env, operation === 'repair-ios-signing' ? 'repair' : 'inspect');
  requireThat(operations.includes(operation) && /^[0-9a-f]{40}$/.test(candidate) &&
    easRootArg && mobileArg && process.argv.length <= 7, 'Invalid recovery arguments.');
  const easRoot = path.resolve(easRootArg);
  const mobile = path.resolve(mobileArg);
  const sdk = createRequire(path.join(easRoot, 'package.json'));
  requireThat(sdk('./package.json').version === SCOPE.easVersion, 'Unexpected EAS CLI version.');
  const exp = JSON.parse(fs.readFileSync(path.join(mobile, 'app.json'), 'utf8')).expo;
  const config = JSON.parse(fs.readFileSync(path.join(mobile, 'eas.json'), 'utf8'));
  requireThat(exp.extra?.eas?.projectId === SCOPE.projectId && exp.slug === SCOPE.slug &&
    exp.ios?.bundleIdentifier === SCOPE.bundle && exp.android?.package === SCOPE.bundle &&
    config.build?.production?.channel === 'production' &&
    config.build.production.distribution === 'store' &&
    config.submit?.production?.ios?.ascAppId === '6804522108' &&
    config.submit.production.ios.appleTeamId === SCOPE.team &&
    config.submit.production.android?.track === 'internal', 'Unexpected local production app configuration.');
  const git = (...args) => execFileSync('git', args, { cwd: mobile, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  requireThat(git('rev-parse', 'HEAD') === candidate && git('status', '--porcelain') === '',
    'The original candidate checkout must be clean and unchanged.');
  const builds = await quiet(() => records(sdk, candidate));
  console.log(JSON.stringify({ candidate, projectId: SCOPE.projectId, builds: builds.map(summary) }, null, 2));
  const command = decide(operation, builds, candidate, buildId);
  if (operation.endsWith('ios-signing') || operation === 'build-ios') {
    if (operation === 'repair-ios-signing') {
      requireThat(!builds.some(build => build.platform === 'IOS' &&
        !['FINISHED', 'ERRORED', 'CANCELED'].includes(build.status)),
      'An iOS build is active; wait before changing its signing association.');
    }
    const report = await quiet(async () => signing.recover(await signing.makeAdapter(easRoot, mobile),
      { apply: operation === 'repair-ios-signing' }));
    console.log(JSON.stringify(report, null, 2));
    if (operation === 'build-ios') requireThat(report.result === 'already-valid',
      'Inspect and repair the confirmed signing incident before starting an iOS build.');
  }
  if (command) {
    // The official CLI owns credential consumption and version increments. Do
    // one platform at a time: an iOS setup error must not orphan an Android build.
    const outcome = spawnSync(process.execPath, [path.join(easRoot, 'bin/run'), ...command], {
      cwd: mobile, env: process.env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    });
    // CLI output may contain signed artifact URLs. Inspect through the filtered
    // query above even on failure; successful scheduling is not store completion.
    const after = await quiet(() => records(sdk, candidate));
    console.log(JSON.stringify({ candidate, builds: after.map(summary) }, null, 2));
    requireThat(outcome.status === 0,
      'EAS operation failed; inspect the reported build/submission IDs in the Expo dashboard.');
    console.log('Operation scheduled. Run inspect until both builds AND their store submissions finish.');
  }
}

module.exports = { validateBuild, decide, summary, records };
if (require.main === module) main().catch(error => {
  console.error(error instanceof Refusal ? error.message : 'Store recovery failed; private SDK details withheld.');
  process.exitCode = 1;
});
