'use strict';

/**
 * Phase 1 — Browser <-> `node-tls-client` 1:1 Parity Bridge (`TlsHeaderBridge.js`)
 *
 * Ensures that for EVERY rotated browser brand (Chrome, Edge, Opera, Brave, Vivaldi,
 * Ungoogled-Chromium, Firefox, Camoufox, Safari):
 *   1. TLS JA3/JA4 & HTTP/2 SETTINGS (`clientIdentifier`) match the exact browser engine.
 *   2. `randomTlsExtensionOrder` is enabled ONLY on Chromium (Chrome 110+ randomizes TLS extensions;
 *      Firefox & Safari use fixed TLS extension order!).
 *   3. `sec-ch-ua*` Client Hints are emitted ONLY for Chromium brands and strictly stripped
 *      from Firefox/Camoufox and Safari/WebKit.
 *   4. HTTP/2 RFC 9113 rules are enforced (never sending `Connection: keep-alive` on h2).
 *   5. `Accept` and `Accept-Encoding` (`zstd` support) match the real browser binary.
 */

const { ENGINE_TYPES } = require('./ProfileCatalog');
const { VALID_TLS_CLIENT_IDS_SET } = (() => {
  const ids = new Set([
    'chrome_103', 'chrome_104', 'chrome_105', 'chrome_106', 'chrome_107', 'chrome_108',
    'chrome_109', 'chrome_110', 'chrome_111', 'chrome_112', 'chrome_116_PSK', 'chrome_116_PSK_PQ',
    'chrome_117', 'chrome_120', 'chrome_124', 'chrome_131', 'chrome_131_PSK',
    'opera_89', 'opera_90', 'opera_91',
    'firefox_102', 'firefox_104', 'firefox_105', 'firefox_106', 'firefox_108',
    'firefox_110', 'firefox_117', 'firefox_120', 'firefox_123', 'firefox_132', 'firefox_133',
    'safari_15_6_1', 'safari_16_0', 'safari_ipad_15_6', 'safari_ios_16_0', 'safari_ios_17_0', 'safari_ios_18_0',
  ]);
  return { VALID_TLS_CLIENT_IDS_SET: ids };
})();

function formatSecChUa(brands) {
  if (!Array.isArray(brands) || brands.length === 0) return '';
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

function formatAcceptLanguage(languages = ['en-US', 'en']) {
  return languages
    .map((lang, idx) => (idx === 0 ? lang : `${lang};q=${Math.max(0.1, (1 - idx * 0.1)).toFixed(1)}`))
    .join(',');
}

/**
 * Build exact `node-tls-client@2.1.0` Session options for a synthesized profile.
 */
function buildTlsSessionOptions(profile, { proxy = null, timeout = 30000 } = {}) {
  const tlsId = VALID_TLS_CLIENT_IDS_SET.has(profile.tlsClientId)
    ? profile.tlsClientId
    : profile.engine === ENGINE_TYPES.FIREFOX
    ? 'firefox_133'
    : profile.engine === ENGINE_TYPES.WEBKIT
    ? 'safari_16_0'
    : 'chrome_131';

  // CRITICAL ANTI-BOT DETAIL:
  // Chrome 110+ shuffles TLS extensions per handshake (`randomTlsExtensionOrder: true`),
  // whereas Firefox (NSS) and Safari (SecureTransport/BoringSSL Apple) use deterministic extension order!
  const randomTlsExtensionOrder = profile.engine === ENGINE_TYPES.CHROMIUM;

  const headerOrder =
    profile.engine === ENGINE_TYPES.FIREFOX
      ? [
          'user-agent',
          'accept',
          'accept-language',
          'accept-encoding',
          'referer',
          'cookie',
          'upgrade-insecure-requests',
          'sec-fetch-dest',
          'sec-fetch-mode',
          'sec-fetch-site',
          'sec-fetch-user',
          'priority',
        ]
      : profile.engine === ENGINE_TYPES.WEBKIT
      ? [
          'accept',
          'sec-fetch-site',
          'cookie',
          'sec-fetch-dest',
          'accept-language',
          'sec-fetch-mode',
          'user-agent',
          'referer',
          'accept-encoding',
        ]
      : [
          'sec-ch-ua',
          'sec-ch-ua-mobile',
          'sec-ch-ua-platform',
          'upgrade-insecure-requests',
          'user-agent',
          'accept',
          'sec-fetch-site',
          'sec-fetch-mode',
          'sec-fetch-user',
          'sec-fetch-dest',
          'referer',
          'accept-encoding',
          'accept-language',
          'cookie',
        ];

  const sessionOpts = {
    clientIdentifier: tlsId,
    timeout,
    randomTlsExtensionOrder,
    forceHttp1: false,
    headerOrder,
  };
  if (proxy) {
    sessionOpts.proxy = proxy;
  }
  return sessionOpts;
}

/**
 * Build browser-authentic HTTP headers for either HTTP/2 (`TlsHttpClient`) or HTTP/1.1 (`NativeHttpClient`).
 */
function buildProfileHttpHeaders(
  profile,
  { http1 = false, isDocumentNavigation = false, extraHeaders = {} } = {}
) {
  const headers = {};
  const acceptLang = formatAcceptLanguage(profile.languages);

  if (profile.engine === ENGINE_TYPES.CHROMIUM) {
    if (profile.sendsClientHints && profile.navigator.userAgentData) {
      headers['sec-ch-ua'] = formatSecChUa(profile.navigator.userAgentData.brands);
      headers['sec-ch-ua-mobile'] = '?0';
      headers['sec-ch-ua-platform'] = `"${profile.navigator.userAgentData.platform}"`;
    }
    if (isDocumentNavigation) {
      headers['Upgrade-Insecure-Requests'] = '1';
    }
    headers['User-Agent'] = profile.navigator.userAgent;
    headers['Accept'] =
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
    headers['Accept-Encoding'] = http1 ? 'gzip, deflate, br' : 'gzip, deflate, br, zstd';
    headers['Accept-Language'] = acceptLang;
  } else if (profile.engine === ENGINE_TYPES.FIREFOX) {
    headers['User-Agent'] = profile.navigator.userAgent;
    headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    headers['Accept-Language'] = acceptLang;
    headers['Accept-Encoding'] = http1 ? 'gzip, deflate, br' : 'gzip, deflate, br, zstd';
    if (isDocumentNavigation) {
      headers['Upgrade-Insecure-Requests'] = '1';
      headers['Priority'] = 'u=0, i';
    }
  } else if (profile.engine === ENGINE_TYPES.WEBKIT) {
    headers['User-Agent'] = profile.navigator.userAgent;
    headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    headers['Accept-Language'] = acceptLang;
    // Safari does NOT advertise zstd
    headers['Accept-Encoding'] = 'gzip, deflate, br';
  }

  // Merge caller extraHeaders safely
  for (const [k, v] of Object.entries(extraHeaders || {})) {
    if (v === undefined || v === null) continue;
    headers[k] = v;
  }

  // Enforce non-Chromium Client-Hints strip (prevents accidental sec-ch-ua leak on Firefox/Safari)
  if (!profile.sendsClientHints) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith('sec-ch-ua')) {
        delete headers[key];
      }
    }
  }

  // Enforce HTTP/2 vs HTTP/1.1 connection header rules (RFC 9113 §8.2.2)
  if (http1) {
    if (!headers.Connection && !headers.connection) {
      headers['Connection'] = 'keep-alive';
    }
  } else {
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (
        lower === 'connection' ||
        lower === 'keep-alive' ||
        lower === 'transfer-encoding' ||
        lower === 'upgrade'
      ) {
        delete headers[key];
      }
    }
  }

  return headers;
}

/**
 * Audit a synthesized profile + its generated TLS/HTTP2 configuration for 100% internal consistency.
 * Returns `{ valid: boolean, violations: string[] }`.
 */
function validateProfileParity(profile) {
  const violations = [];
  const tlsOpts = buildTlsSessionOptions(profile);
  const h2Headers = buildProfileHttpHeaders(profile, { http1: false, isDocumentNavigation: true });
  const h1Headers = buildProfileHttpHeaders(profile, { http1: true, isDocumentNavigation: true });
  const ua = profile.navigator?.userAgent || '';

  // 1. Valid node-tls-client identifier
  if (!VALID_TLS_CLIENT_IDS_SET.has(tlsOpts.clientIdentifier)) {
    violations.push(`Invalid TLS clientIdentifier: ${tlsOpts.clientIdentifier}`);
  }

  // 2. Engine <-> TLS family parity
  if (profile.engine === ENGINE_TYPES.CHROMIUM) {
    if (!tlsOpts.clientIdentifier.startsWith('chrome_') && !tlsOpts.clientIdentifier.startsWith('opera_')) {
      violations.push(`Chromium brand ${profile.brandId} mapped to non-Chromium TLS ${tlsOpts.clientIdentifier}`);
    }
    if (!tlsOpts.randomTlsExtensionOrder) {
      violations.push('Chromium profile should enable randomTlsExtensionOrder');
    }
    if (!h2Headers['sec-ch-ua'] || !h2Headers['sec-ch-ua-platform']) {
      violations.push(`Chromium brand ${profile.brandId} missing sec-ch-ua headers`);
    }
    if (!ua.includes('Chrome/')) {
      violations.push(`Chromium UA missing Chrome/ token: ${ua}`);
    }
  } else if (profile.engine === ENGINE_TYPES.FIREFOX) {
    if (!tlsOpts.clientIdentifier.startsWith('firefox_')) {
      violations.push(`Gecko brand ${profile.brandId} mapped to non-Firefox TLS ${tlsOpts.clientIdentifier}`);
    }
    if (tlsOpts.randomTlsExtensionOrder) {
      violations.push('Firefox/Gecko profile must NOT enable randomTlsExtensionOrder');
    }
    if (Object.keys(h2Headers).some((k) => k.toLowerCase().startsWith('sec-ch-ua'))) {
      violations.push('Firefox/Gecko profile leaked sec-ch-ua header');
    }
    if (profile.navigator.userAgentData !== null) {
      violations.push('Firefox/Gecko profile must have null navigator.userAgentData');
    }
    if (profile.navigator.deviceMemory !== undefined) {
      violations.push('Firefox/Gecko profile must have undefined navigator.deviceMemory');
    }
    if (!ua.includes('Gecko/20100101 Firefox/')) {
      violations.push(`Firefox UA malformed: ${ua}`);
    }
  } else if (profile.engine === ENGINE_TYPES.WEBKIT) {
    if (!tlsOpts.clientIdentifier.startsWith('safari_')) {
      violations.push(`WebKit brand ${profile.brandId} mapped to non-Safari TLS ${tlsOpts.clientIdentifier}`);
    }
    if (tlsOpts.randomTlsExtensionOrder) {
      violations.push('Safari/WebKit profile must NOT enable randomTlsExtensionOrder');
    }
    if (Object.keys(h2Headers).some((k) => k.toLowerCase().startsWith('sec-ch-ua'))) {
      violations.push('Safari/WebKit profile leaked sec-ch-ua header');
    }
    if (h2Headers['Accept-Encoding']?.includes('zstd')) {
      violations.push('Safari/WebKit profile must not advertise zstd Accept-Encoding');
    }
    if (profile.os !== 'macos') {
      violations.push(`Desktop Safari generated on non-macOS platform: ${profile.os}`);
    }
    if (!ua.includes('Safari/') || ua.includes('Chrome/')) {
      violations.push(`Safari UA malformed: ${ua}`);
    }
  }

  // 3. OS <-> Navigator Platform & GPU Renderer parity
  const renderer = profile.gpu?.renderer || '';
  if (profile.os === 'windows') {
    if (profile.navigator.platform !== 'Win32') {
      violations.push(`Windows profile has wrong navigator.platform: ${profile.navigator.platform}`);
    }
    if (/Apple M[1234]|Apple GPU|Mesa/i.test(renderer)) {
      violations.push(`Windows profile assigned non-Windows GPU: ${renderer}`);
    }
  } else if (profile.os === 'macos') {
    if (profile.navigator.platform !== 'MacIntel') {
      violations.push(`macOS profile has wrong navigator.platform: ${profile.navigator.platform}`);
    }
    if (/Direct3D11|D3D11|Mesa/i.test(renderer)) {
      violations.push(`macOS profile assigned Direct3D/Mesa GPU: ${renderer}`);
    }
  } else if (profile.os === 'linux') {
    if (profile.navigator.platform !== 'Linux x86_64') {
      violations.push(`Linux profile has wrong navigator.platform: ${profile.navigator.platform}`);
    }
    if (/Direct3D11|D3D11|Apple M[1234]|Apple GPU/i.test(renderer)) {
      violations.push(`Linux profile assigned Windows/Apple GPU: ${renderer}`);
    }
  }

  // 4. HTTP/2 RFC 9113 Connection header check
  if ('Connection' in h2Headers || 'connection' in h2Headers) {
    violations.push('HTTP/2 headers must NEVER contain Connection header');
  }
  if (h1Headers.Connection !== 'keep-alive') {
    violations.push('HTTP/1.1 headers should contain Connection: keep-alive');
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Adapter helper to convert a Phase 1 `synthesizedProfile` into an enriched solver profile
 * compatible with `TlsHttpClient` and `RedditSolver`.
 */
function toSolverProfileAdapter(synthesizedProfile) {
  const tlsOpts = buildTlsSessionOptions(synthesizedProfile);
  const h2Base = buildProfileHttpHeaders(synthesizedProfile, { http1: false });
  return {
    name: `${synthesizedProfile.brandId}_${synthesizedProfile.versionMajor}_${synthesizedProfile.os}`,
    signatureId: synthesizedProfile.signatureId,
    brandId: synthesizedProfile.brandId,
    engine: synthesizedProfile.engine,
    os: synthesizedProfile.os,
    tlsClientId: tlsOpts.clientIdentifier,
    tlsClientIdRequested: tlsOpts.clientIdentifier,
    tlsClientIdFallbackUsed: false,
    randomTlsExtensionOrder: tlsOpts.randomTlsExtensionOrder,
    headerOrder: tlsOpts.headerOrder,
    userAgent: synthesizedProfile.navigator.userAgent,
    secChUa: h2Base['sec-ch-ua'] || null,
    secChUaMobile: h2Base['sec-ch-ua-mobile'] || null,
    secChUaPlatform: h2Base['sec-ch-ua-platform'] || null,
    sendsClientHints: synthesizedProfile.sendsClientHints,
    supportsZstd: synthesizedProfile.supportsZstd,
    synthesized: synthesizedProfile,
  };
}

module.exports = {
  VALID_TLS_CLIENT_IDS_SET,
  formatSecChUa,
  formatAcceptLanguage,
  buildTlsSessionOptions,
  buildProfileHttpHeaders,
  validateProfileParity,
  toSolverProfileAdapter,
};
