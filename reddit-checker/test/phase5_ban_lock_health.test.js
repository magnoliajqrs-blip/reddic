'use strict';

/**
 * Phase 5 Automated Test Suite:
 * Post-Login Ban, Temporary Ban, Shadowban & Password-Reset Lock Detection (`v2.3.0`)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initTLS, destroyTLS } = require('node-tls-client');

const {
  RedditSolver,
  ensureWindowsTlsDllReady,
  classifyLoginResponse,
  classifyAccountHealthData,
  getTlsClientAssetInfo,
} = require('../reddit_solver');
const { createOutPaths, recordAccountOutcome } = require('../reddit_checker');

async function runPhase5Tests() {
  console.log('========================================================================');
  console.log('  PHASE 5 TEST SUITE: BAN / SHADOWBAN / PASSWORD-RESET DETECTION');
  console.log('========================================================================\n');

  // -------------------------------------------------------------------------
  // SUITE 1: Step 4 Login Response Classifier Guards
  // -------------------------------------------------------------------------
  console.log('[Suite 1/4] Step 4 classifyLoginResponse Redirect & OTP 202 Guards...');
  {
    const otp202 = classifyLoginResponse({ status: 202, headers: {}, text: '{}', cookies: {} });
    assert.strictEqual(otp202.authenticated, false);
    assert.strictEqual(otp202.category, 'OTP_REQUIRED');

    const passResetRedirect = classifyLoginResponse({
      status: 200,
      headers: { 'content-type': 'text/vnd.reddit.partial+html' },
      text: '<faceplate-redirect href="/resetpassword"></faceplate-redirect>',
      cookies: { reddit_session: 'sess_locked' },
    });
    assert.strictEqual(passResetRedirect.authenticated, false, 'Password reset redirect must NOT be authenticated');
    assert.strictEqual(passResetRedirect.category, 'PASSWORD_RESET_REQUIRED');

    const appealsRedirect = classifyLoginResponse({
      status: 200,
      headers: { 'content-type': 'text/vnd.reddit.partial+html' },
      text: '<faceplate-redirect href="/appeals"></faceplate-redirect>',
      cookies: { reddit_session: 'sess_banned' },
    });
    assert.strictEqual(appealsRedirect.authenticated, false, '/appeals redirect must NOT be authenticated');
    assert.strictEqual(appealsRedirect.category, 'BANNED_SUSPENDED');

    const securityAlert400 = classifyLoginResponse({
      status: 400,
      headers: {},
      text: '<faceplate-alert message="We&#x27;ve locked your account as a security precaution. Please reset your password."></faceplate-alert>',
      cookies: {},
    });
    assert.strictEqual(securityAlert400.category, 'PASSWORD_RESET_REQUIRED');
  }
  console.log('  -> Suite 1 PASSED!\n');

  // -------------------------------------------------------------------------
  // SUITE 2: Step 5 `classifyAccountHealthData` Full State Matrix
  // -------------------------------------------------------------------------
  console.log('[Suite 2/4] Step 5 classifyAccountHealthData 9-Scenario Matrix...');
  {
    // 1. Clean Active Account (including email:pass canonical username resolution)
    const active = classifyAccountHealthData({
      fallbackUsername: 'user@example.com',
      meStatus: 200,
      meJson: {
        name: 'RealActiveUser',
        id: 'xyz987',
        is_suspended: false,
        force_password_reset: false,
        password_set: true,
        link_karma: 320,
        comment_karma: 1680,
        total_karma: 2000,
        created_utc: Math.floor(Date.now() / 1000) - 86400 * 400,
        has_verified_email: true,
      },
      publicAboutStatus: 200,
      publicAboutJson: { kind: 't2', data: { name: 'RealActiveUser', over_18: true } },
    });
    assert.strictEqual(active.healthy, true);
    assert.strictEqual(active.verdict, 'AUTHENTICATED');
    assert.strictEqual(active.username, 'RealActiveUser');
    assert.strictEqual(active.totalKarma, 2000);
    assert.strictEqual(active.emailVerified, true);

    // 2. Permanent Ban (`me.is_suspended === true`)
    const permBan = classifyAccountHealthData({
      fallbackUsername: 'perm_user',
      meStatus: 200,
      meJson: { name: 'PermUser', id: 'p1', is_suspended: true, suspension_expiration_utc: null, password_set: true },
    });
    assert.strictEqual(permBan.healthy, false);
    assert.strictEqual(permBan.verdict, 'BANNED_SUSPENDED');

    // 3. Temporary Ban (`suspension_expiration_utc` in future)
    const tempBan = classifyAccountHealthData({
      fallbackUsername: 'temp_user',
      meStatus: 200,
      meJson: {
        name: 'TempUser',
        id: 't1',
        is_suspended: true,
        suspension_expiration_utc: Math.floor(Date.now() / 1000) + 86400 * 3,
        password_set: true,
      },
    });
    assert.strictEqual(tempBan.healthy, false);
    assert.strictEqual(tempBan.verdict, 'BANNED_TEMP');

    // 4. Shadowbanned (`me.name` exists, `is_suspended: false`, anonymous `/about` returns 404)
    const shadowBan = classifyAccountHealthData({
      fallbackUsername: 'shadow_user',
      meStatus: 200,
      meJson: { name: 'ShadowUser', id: 's1', is_suspended: false, force_password_reset: false, password_set: true },
      publicAboutStatus: 404,
      publicAboutJson: { error: 404, message: 'Not Found' },
    });
    assert.strictEqual(shadowBan.healthy, false);
    assert.strictEqual(shadowBan.verdict, 'SHADOWBANNED');

    // 5. Public profile suspended (`publicAboutJson.data.is_suspended === true`)
    const pubSusp = classifyAccountHealthData({
      fallbackUsername: 'pub_susp',
      meStatus: 200,
      meJson: { name: 'PubSusp', id: 'ps1', is_suspended: false, password_set: true },
      publicAboutStatus: 200,
      publicAboutJson: { kind: 't2', data: { name: 'PubSusp', is_suspended: true } },
    });
    assert.strictEqual(pubSusp.healthy, false);
    assert.strictEqual(pubSusp.verdict, 'BANNED_SUSPENDED');

    // 6. Force Password Reset (`me.force_password_reset === true`)
    const forceReset = classifyAccountHealthData({
      fallbackUsername: 'reset_user',
      meStatus: 200,
      meJson: { name: 'ResetUser', id: 'r1', is_suspended: false, force_password_reset: true, password_set: true },
    });
    assert.strictEqual(forceReset.healthy, false);
    assert.strictEqual(forceReset.verdict, 'PASSWORD_RESET_REQUIRED');

    // 7. Password Cleared (`me.password_set === false`)
    const passCleared = classifyAccountHealthData({
      fallbackUsername: 'cleared_user',
      meStatus: 200,
      meJson: { name: 'ClearedUser', id: 'c1', is_suspended: false, force_password_reset: false, password_set: false },
    });
    assert.strictEqual(passCleared.healthy, false);
    assert.strictEqual(passCleared.verdict, 'PASSWORD_RESET_REQUIRED');

    // 8. Shreddit Settings Security Lock Banner
    const settingsLock = classifyAccountHealthData({
      fallbackUsername: 'lock_banner',
      meStatus: 200,
      meJson: { name: 'LockBanner', id: 'lb1', is_suspended: false, force_password_reset: false, password_set: true },
      publicAboutStatus: 200,
      settingsHtml: '<faceplate-banner>Uh oh! We have suspended your account due to suspicious activity. Reset your password to continue.</faceplate-banner>',
    });
    assert.strictEqual(settingsLock.healthy, false);
    assert.strictEqual(settingsLock.verdict, 'PASSWORD_RESET_REQUIRED');

    // 9. Shreddit Ban Banner on `/settings/account`
    const settingsBan = classifyAccountHealthData({
      fallbackUsername: 'ban_banner',
      meStatus: 200,
      meJson: { name: 'BanBanner', id: 'bb1', is_suspended: false, force_password_reset: false, password_set: true },
      publicAboutStatus: 200,
      settingsHtml: '<shreddit-ban-banner>Your account has been permanently banned from Reddit.</shreddit-ban-banner>',
    });
    assert.strictEqual(settingsBan.healthy, false);
    assert.strictEqual(settingsBan.verdict, 'BANNED_SUSPENDED');

    // 10. ANTI-POLLUTION: ALL probes failed (network/token) -> MUST NOT be classified as clean hit!
    const allProbesFailed = classifyAccountHealthData({
      fallbackUsername: 'flaky_net',
      meStatus: 0,
      meJson: null,
      publicAboutStatus: 0,
      publicAboutJson: null,
    });
    assert.strictEqual(allProbesFailed.healthy, false, 'Failed probes must NEVER be a clean hit!');
    assert.strictEqual(allProbesFailed.verdict, 'SESSION_INVALID');

    // 11. ANTI-POLLUTION: me OK but public ban probe blocked (WAF 403 / rate-limit) -> NOT clean
    const publicProbeBlocked = classifyAccountHealthData({
      fallbackUsername: 'waf_blocked',
      meStatus: 200,
      meJson: { name: 'WafBlocked', id: 'w1', is_suspended: false, force_password_reset: false, password_set: true },
      publicAboutStatus: 403,
      publicAboutJson: null,
    });
    assert.strictEqual(publicProbeBlocked.healthy, false, 'Inconclusive public probe must NEVER be a clean hit!');
    assert.strictEqual(publicProbeBlocked.verdict, 'SESSION_INVALID');

    // 12. LIVE-VERIFIED BAN SIGNATURE: login OK, but /api/v1/me = 200 identity-stripped
    //     ({"features": {...}} only) + public profile normal -> BANNED_SUSPENDED (real banned accs 2026-10-29)
    const stripped = classifyAccountHealthData({
      fallbackUsername: 'banned_acc',
      meStatus: 200,
      meJson: { features: { chat_subreddit: true, awards_on_streams: true } },
      publicAboutStatus: 200,
      publicAboutJson: { kind: 't2', data: { name: 'banned_acc', total_karma: 5 } },
      settingsHtml: '<shreddit-app user-logged-in="true"></shreddit-app>',
      settingsFinalUrl: 'https://www.reddit.com/settings/account',
    });
    assert.strictEqual(stripped.healthy, false, 'Identity-stripped /me MUST NOT be a clean hit!');
    assert.strictEqual(stripped.verdict, 'BANNED_SUSPENDED');
    assert.strictEqual(stripped.statusLabel, 'IDENTITY_STRIPPED_ME_SESSION');

    // 13. Identity-stripped BUT public probe also failed -> inconclusive (retry, NOT false ban)
    const strippedNoCorroboration = classifyAccountHealthData({
      fallbackUsername: 'maybe_banned',
      meStatus: 200,
      meJson: { features: {} },
      publicAboutStatus: 0,
      publicAboutJson: null,
    });
    assert.strictEqual(strippedNoCorroboration.healthy, false);
    assert.strictEqual(strippedNoCorroboration.verdict, 'SESSION_INVALID');

    // 14. Identity-stripped BUT session degraded by IP network-security flag (settings force-
    //     redirects to /login) -> inconclusive retry, NEVER a false ban (live-observed 2026-10-29)
    const ipFlagged = classifyAccountHealthData({
      fallbackUsername: 'valid_acc_flagged_ip',
      meStatus: 200,
      meJson: { features: { chat_subreddit: true } },
      publicAboutStatus: 200,
      publicAboutJson: { kind: 't2', data: { name: 'valid_acc_flagged_ip', total_karma: 1 } },
      settingsHtml: '<html>login page</html>',
      settingsFinalUrl: 'https://www.reddit.com/login/?dest=https%3A%2F%2Fwww.reddit.com%2Fsettings%2Faccount',
    });
    assert.strictEqual(ipFlagged.healthy, false);
    assert.strictEqual(ipFlagged.verdict, 'SESSION_INVALID', 'IP-flag degraded session must NOT be a false ban!');
  }
  console.log('  -> Suite 2 PASSED!\n');

  // -------------------------------------------------------------------------
  // SUITE 3: `fullLogin()` + `recordAccountOutcome()` End-to-End Integration
  // -------------------------------------------------------------------------
  console.log('[Suite 3/4] fullLogin() Post-Auth Interception & File Routing...');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-routing-'));
    try {
      const outPaths = createOutPaths(tmpDir);
      const stats = { hits: 0, banned: 0, passwordReset: 0, twoFa: 0, invalid: 0, errors: 0 };

      // Simulate an account that PASSED Step 4 (`success: true`, `reddit_session` issued!)
      // BUT Step 5 `verifyAccountHealth()` discovers `is_suspended: true`!
      const mockSolver = Object.create(RedditSolver.prototype);
      mockSolver.mode = 'http';
      mockSolver.profile = { brandId: 'firefox', engine: 'firefox', os: 'windows', tlsClientId: 'firefox_133' };
      mockSolver.logger = {
        error: () => {},
        dumpOnError: false,
        dumpAlways: false,
      };
      mockSolver.ensureProfileLease = async () => {};
      mockSolver.solveJsChallenge = async () => {};
      mockSolver.acquireRecaptchaToken = async () => ({ recaptchaToken: '03AFcWeA_mock', method: 'http' });
      mockSolver.login = async () => ({
        success: true,
        status: 200,
        verdict: 'AUTHENTICATED',
        otpRequired: false,
        messages: [],
        jwtInfo: { sub: 't2_banned99', isAuthenticatedUser: true },
        cookies: { reddit_session: 'sess_123', token_v2: 'jwt_123' },
      });
      mockSolver.verifyAccountHealth = async () => ({
        healthy: false,
        verdict: 'BANNED_SUSPENDED',
        statusLabel: 'PERMANENTLY_BANNED',
        reason: 'Account is permanently banned / suspended on Reddit (me.is_suspended=true)',
        username: 'SneakyBannedAcc',
        totalKarma: 410,
      });
      mockSolver.close = async () => {};

      const loginOut = await mockSolver.fullLogin('sneaky_banned', 'ValidPass123', { quiet: true });
      assert.strictEqual(loginOut.success, false, 'fullLogin MUST flip success to false when Step 5 detects ban!');
      assert.strictEqual(loginOut.credentialsValid, true, 'Should preserve credentialsValid=true');
      assert.strictEqual(loginOut.verdict, 'BANNED_SUSPENDED');

      recordAccountOutcome({
        res: { ...loginOut, brandId: 'firefox', engine: 'firefox' },
        acct: { username: 'sneaky_banned', password: 'ValidPass123', combo: 'sneaky_banned:ValidPass123' },
        stats,
        outPaths,
      });

      assert.strictEqual(stats.hits, 0, 'Banned account with valid password MUST NEVER increment hits!');
      assert.strictEqual(stats.banned, 1, 'Must increment banned counter!');
      assert.strictEqual(fs.existsSync(outPaths.hits), false, 'hits.txt must NOT even be created for banned-only run!');
      assert(fs.readFileSync(outPaths.banned, 'utf-8').includes('sneaky_banned:ValidPass123'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  console.log('  -> Suite 3 PASSED!\n');

  // -------------------------------------------------------------------------
  // SUITE 4: Live Reddit Production Verification (Active vs Suspended vs Shadowban 404)
  // -------------------------------------------------------------------------
  console.log('[Suite 4/4] Live Reddit OAuth Public Profile Probe (Active vs Suspended vs 404)...');
  const tlsAsset = getTlsClientAssetInfo();
  if (!tlsAsset.ok) {
    console.log(`  SKIP: node-tls-client native library not present (${tlsAsset.tempPath}) — the live
  probe needs it; run \`node reddit_solver.js --diagnose\` once with network to fetch it.`);
  } else {
    ensureWindowsTlsDllReady();
    await initTLS();
    const solver = new RedditSolver({ mode: 'http', headless: true });
    try {
      await solver.solveJsChallenge();
      assert(solver.anonymousTokenV2.length > 20, 'Step 1 must seed solver.anonymousTokenV2');

      const [activePub, suspendedPub, shadowPub] = await Promise.all([
        solver.queryAnonymousPublicProfile('spez'),
        solver.queryAnonymousPublicProfile('deepfakes'),
        solver.queryAnonymousPublicProfile('violentacrez'),
      ]);

      assert.strictEqual(activePub.status, 200, 'Active account spez must return HTTP 200');
      assert.strictEqual(Boolean(activePub.json?.data?.is_suspended), false, 'spez must NOT be suspended');

      assert.strictEqual(suspendedPub.status, 200, 'Suspended account deepfakes returns 200 with is_suspended=true');
      assert.strictEqual(suspendedPub.json?.data?.is_suspended, true, 'deepfakes must report is_suspended=true');

      assert.strictEqual(shadowPub.status, 404, 'Shadowbanned/purged violentacrez must return HTTP 404');

      console.log(
        `  -> Live Probe OK: spez=(200 ACTIVE), deepfakes=(200 is_suspended=true), violentacrez=(404 SHADOWBANNED/HIDDEN)`
      );
    } finally {
      await solver.close();
      await destroyTLS().catch(() => {});
    }
    console.log('  -> Suite 4 PASSED!\n');
  }

  console.log('========================================================================');
  console.log('  ALL PHASE 5 BAN / SHADOWBAN / PASSWORD-RESET TESTS PASSED!');
  console.log('========================================================================');
}

runPhase5Tests().catch((err) => {
  console.error('\n[PHASE 5 TEST FAILED]', err);
  process.exit(1);
});
