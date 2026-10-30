'use strict';

/**
 * Phase 1 — Browser Profile & Hardware Catalog (`ProfileCatalog.js`)
 *
 * Defines 9 distinct browser brands across all 3 real browser engines:
 *   - Chromium Engine (Method 1 Single-Engine Context Pool & Method 2):
 *       1. chrome              (Google Chrome)
 *       2. edge                (Microsoft Edge)
 *       3. opera               (Opera Browser)
 *       4. brave               (Brave Open-Source Browser)
 *       5. vivaldi             (Vivaldi Browser)
 *       6. ungoogled_chromium  (Open-Source Fingerprint-Chromium / Ungoogled-Chromium)
 *   - Gecko Engine (Method 2 Native Firefox / Open-Source Camoufox):
 *       7. firefox             (Mozilla Firefox)
 *       8. camoufox            (Open-Source Camoufox / LibreWolf Anti-Detect Gecko)
 *   - WebKit Engine (Method 2 Native Safari WebKit):
 *       9. safari              (Apple Safari)
 *
 * Also enforces strict OS <-> GPU WebGL <-> Screen <-> Timezone/Locale hardware realism
 * so impossible combinations (e.g., Windows + Apple M3 GPU, or Linux + Safari) can NEVER occur.
 */

const ENGINE_TYPES = Object.freeze({
  CHROMIUM: 'chromium',
  FIREFOX: 'firefox', // Gecko (Mozilla Firefox & Camoufox)
  WEBKIT: 'webkit',   // Apple WebKit (Safari)
});

// Verified against `node-tls-client@2.1.0` ClientIdentifier enum
const SUPPORTED_TLS_IDENTIFIERS = Object.freeze({
  chromium: ['chrome_131', 'chrome_131_PSK', 'chrome_124', 'chrome_120'],
  opera: ['opera_91', 'chrome_131'],
  firefox: ['firefox_133', 'firefox_132', 'firefox_123', 'firefox_120'],
  webkit: ['safari_16_0', 'safari_15_6_1'],
});

// OS-accurate WebGL Vendor & Renderer presets (prevents OS/GPU mismatch detection)
const OS_GPU_CATALOG = Object.freeze({
  windows: [
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    // W19: expanded GPU pool
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
  ],
  macos: [
    {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
    },
    {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    },
    {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
    },
    {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)',
    },
  ],
  linux: [
    {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6)',
    },
    {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir, LLVM 17.0.6, DRM 3.57, 6.8.0), OpenGL 4.6)',
    },
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070/PCIe/SSE2, OpenGL 4.6.0)',
    },
  ],
});

// Firefox/Gecko & Safari/WebKit report unmasked WebGL strings slightly differently on some OSes
const GECKO_WEBKIT_GPU_CATALOG = Object.freeze({
  windows: [
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0), or similar' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0), or similar' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0), or similar' },
  ],
  macos: [
    { vendor: 'Apple Inc.', renderer: 'Apple GPU' },
    { vendor: 'Apple', renderer: 'ANGLE Metal Renderer: Apple M2, Unspecified Version' },
  ],
  linux: [
    { vendor: 'Intel', renderer: 'Mesa Intel(R) UHD Graphics 620 (KBL GT2)' },
    { vendor: 'AMD', renderer: 'AMD Radeon RX 6700 XT (radeonsi, navi22, LLVM 17.0.6)' },
  ],
});

const DESKTOP_RESOLUTIONS = Object.freeze({
  windows: [
    { width: 1920, height: 1080, dpr: 1, availHeightDrop: 48 },
    { width: 1536, height: 864, dpr: 1.25, availHeightDrop: 40 },
    { width: 2560, height: 1440, dpr: 1, availHeightDrop: 48 },
    { width: 1680, height: 1050, dpr: 1, availHeightDrop: 40 },
    { width: 1366, height: 768, dpr: 1, availHeightDrop: 40 },
    // W19: expanded realistic pool
    { width: 1600, height: 900, dpr: 1, availHeightDrop: 40 },
    { width: 3440, height: 1440, dpr: 1, availHeightDrop: 48 },
    { width: 1920, height: 1200, dpr: 1, availHeightDrop: 48 },
    { width: 3840, height: 2160, dpr: 1.5, availHeightDrop: 48 },
  ],
  macos: [
    { width: 1440, height: 900, dpr: 2, availHeightDrop: 25 },
    { width: 1512, height: 982, dpr: 2, availHeightDrop: 38 },
    { width: 1728, height: 1117, dpr: 2, availHeightDrop: 38 },
    { width: 1680, height: 1050, dpr: 2, availHeightDrop: 25 },
    // W19: expanded realistic pool
    { width: 1920, height: 1080, dpr: 2, availHeightDrop: 25 },
    { width: 2560, height: 1440, dpr: 1, availHeightDrop: 25 },
  ],
  linux: [
    { width: 1920, height: 1080, dpr: 1, availHeightDrop: 32 },
    { width: 2560, height: 1440, dpr: 1, availHeightDrop: 32 },
    { width: 1600, height: 900, dpr: 1, availHeightDrop: 28 },
    // W19: expanded realistic pool
    { width: 1366, height: 768, dpr: 1, availHeightDrop: 28 },
    { width: 1680, height: 1050, dpr: 1, availHeightDrop: 32 },
  ],
});

const LOCALE_TIMEZONE_PRESETS = Object.freeze([
  { locale: 'en-US', languages: ['en-US', 'en'], timezoneId: 'America/New_York', tzOffsetMin: 240 },
  { locale: 'en-US', languages: ['en-US', 'en'], timezoneId: 'America/Chicago', tzOffsetMin: 300 },
  { locale: 'en-US', languages: ['en-US', 'en'], timezoneId: 'America/Los_Angeles', tzOffsetMin: 420 },
  { locale: 'en-GB', languages: ['en-GB', 'en-US', 'en'], timezoneId: 'Europe/London', tzOffsetMin: 0 },
  { locale: 'en-CA', languages: ['en-CA', 'en-US', 'en'], timezoneId: 'America/Toronto', tzOffsetMin: 240 },
  { locale: 'en-AU', languages: ['en-AU', 'en-US', 'en'], timezoneId: 'Australia/Sydney', tzOffsetMin: -660 },
  // W19: expanded locale/timezone pool
  { locale: 'en-US', languages: ['en-US', 'en'], timezoneId: 'America/Denver', tzOffsetMin: 360 },
  { locale: 'en-GB', languages: ['en-GB', 'en'], timezoneId: 'Europe/Dublin', tzOffsetMin: -60 },
  { locale: 'en-US', languages: ['en-US', 'en'], timezoneId: 'America/Phoenix', tzOffsetMin: 420 },
]);

/**
 * Master Browser Brand Catalog (9 distinct browser brands across 3 engines)
 *
 * `poolCompatibility`:
 *   - 'single-or-multi': Works in BOTH Method 1 (Single Chromium Engine Context Pool) & Method 2
 *   - 'multi-only':      Requires Method 2 (Real Gecko or Real WebKit engine — never faked in Chromium!)
 */
const BROWSER_BRAND_CATALOG = Object.freeze([
  {
    brandId: 'chrome',
    displayName: 'Google Chrome',
    engine: ENGINE_TYPES.CHROMIUM,
    generatorBaseBrowser: 'chrome',
    poolCompatibility: 'single-or-multi',
    fingerprintChromiumBrand: 'Chrome',
    openSourceAntiDetect: false,
    sendsClientHints: true,
    supportsZstd: true,
    supportedOs: ['windows', 'macos', 'linux'],
    // Note: Fastly WAF blocks the exact `curl_cffi` default scraper string `Macintosh ... Chrome/131.0.0.0`
    // (without Edg/ or OPR/), whereas Chrome/130.0.0.0 + `chrome_131` TLS & Chrome/124/120 on macOS pass 100%!
    versions: [
      { major: '131', full: '131.0.6778.86', tlsClientId: 'chrome_131', greaseBrand: 'Not_A Brand', greaseVer: '24', supportedOs: ['windows', 'linux'] },
      // W9: PSK (post-quantum hybrid keyshare) variant — matches modern Chrome 131+ handshakes
      { major: '131', full: '131.0.6778.140', tlsClientId: 'chrome_131_PSK', greaseBrand: 'Not;A=Brand', greaseVer: '99', supportedOs: ['windows', 'macos', 'linux'] },
      { major: '130', full: '130.0.6723.117', tlsClientId: 'chrome_131', greaseBrand: 'Not?A_Brand', greaseVer: '99', supportedOs: ['windows', 'macos', 'linux'] },
      { major: '124', full: '124.0.6367.207', tlsClientId: 'chrome_124', greaseBrand: 'Not-A.Brand', greaseVer: '99', supportedOs: ['windows', 'macos', 'linux'] },
      { major: '120', full: '120.0.6099.225', tlsClientId: 'chrome_120', greaseBrand: 'Not_A Brand', greaseVer: '8', supportedOs: ['windows', 'macos', 'linux'] },
    ],
  },
  {
    brandId: 'edge',
    displayName: 'Microsoft Edge',
    engine: ENGINE_TYPES.CHROMIUM,
    generatorBaseBrowser: 'edge',
    poolCompatibility: 'single-or-multi',
    fingerprintChromiumBrand: 'Edge',
    openSourceAntiDetect: false,
    sendsClientHints: true,
    supportsZstd: true,
    supportedOs: ['windows', 'macos'],
    versions: [
      { major: '131', full: '131.0.2903.70', chromiumMajor: '131', tlsClientId: 'chrome_131', greaseBrand: 'Not_A Brand', greaseVer: '24' },
      { major: '124', full: '124.0.2478.97', chromiumMajor: '124', tlsClientId: 'chrome_124', greaseBrand: 'Not-A.Brand', greaseVer: '99' },
    ],
  },
  {
    brandId: 'opera',
    displayName: 'Opera Browser',
    engine: ENGINE_TYPES.CHROMIUM,
    generatorBaseBrowser: 'chrome',
    poolCompatibility: 'single-or-multi',
    fingerprintChromiumBrand: 'Opera',
    openSourceAntiDetect: false,
    sendsClientHints: true,
    supportsZstd: true,
    supportedOs: ['windows', 'macos'],
    versions: [
      { major: '114', full: '114.0.5282.185', chromiumMajor: '130', chromiumFull: '130.0.6723.117', tlsClientId: 'chrome_131', greaseBrand: 'Not?A_Brand', greaseVer: '99' },
      { major: '91', full: '91.0.4516.77', chromiumMajor: '105', chromiumFull: '105.0.5195.127', tlsClientId: 'opera_91', greaseBrand: 'Not)A;Brand', greaseVer: '8' },
    ],
  },
  {
    brandId: 'brave',
    displayName: 'Brave Privacy Browser (Open-Source)',
    engine: ENGINE_TYPES.CHROMIUM,
    generatorBaseBrowser: 'chrome',
    poolCompatibility: 'single-or-multi',
    fingerprintChromiumBrand: 'Brave',
    openSourceAntiDetect: true,
    sendsClientHints: true,
    supportsZstd: true,
    supportedOs: ['windows', 'macos', 'linux'],
    versions: [
      { major: '131', full: '131.0.6778.85', tlsClientId: 'chrome_131', greaseBrand: 'Not_A Brand', greaseVer: '24', supportedOs: ['windows', 'linux'] },
      { major: '130', full: '130.0.6723.91', tlsClientId: 'chrome_131', greaseBrand: 'Not?A_Brand', greaseVer: '99', supportedOs: ['windows', 'macos', 'linux'] },
      { major: '124', full: '124.0.6367.118', tlsClientId: 'chrome_124', greaseBrand: 'Not-A.Brand', greaseVer: '99', supportedOs: ['windows', 'macos', 'linux'] },
    ],
  },
  {
    brandId: 'vivaldi',
    displayName: 'Vivaldi Browser',
    engine: ENGINE_TYPES.CHROMIUM,
    generatorBaseBrowser: 'chrome',
    poolCompatibility: 'single-or-multi',
    fingerprintChromiumBrand: 'Vivaldi',
    openSourceAntiDetect: false,
    sendsClientHints: true,
    supportsZstd: true,
    supportedOs: ['windows', 'macos', 'linux'],
    versions: [
      { major: '7.0', full: '7.0.3495.15', chromiumMajor: '130', chromiumFull: '130.0.6723.119', tlsClientId: 'chrome_131', greaseBrand: 'Not?A_Brand', greaseVer: '99' },
      { major: '6.7', full: '6.7.3329.31', chromiumMajor: '124', chromiumFull: '124.0.6367.207', tlsClientId: 'chrome_124', greaseBrand: 'Not-A.Brand', greaseVer: '99' },
    ],
  },
  {
    brandId: 'ungoogled_chromium',
    displayName: 'Fingerprint-Chromium / Ungoogled-Chromium (Open-Source)',
    engine: ENGINE_TYPES.CHROMIUM,
    generatorBaseBrowser: 'chrome',
    poolCompatibility: 'single-or-multi',
    fingerprintChromiumBrand: 'Chromium',
    openSourceAntiDetect: true,
    sendsClientHints: true,
    supportsZstd: true,
    supportedOs: ['windows', 'macos', 'linux'],
    versions: [
      { major: '131', full: '131.0.6778.86', tlsClientId: 'chrome_131', greaseBrand: 'Not_A Brand', greaseVer: '24', supportedOs: ['windows', 'linux'] },
      { major: '130', full: '130.0.6723.116', tlsClientId: 'chrome_131', greaseBrand: 'Not?A_Brand', greaseVer: '99', supportedOs: ['windows', 'macos', 'linux'] },
      { major: '124', full: '124.0.6367.201', tlsClientId: 'chrome_124', greaseBrand: 'Not-A.Brand', greaseVer: '99', supportedOs: ['windows', 'macos', 'linux'] },
    ],
  },
  {
    brandId: 'firefox',
    displayName: 'Mozilla Firefox',
    engine: ENGINE_TYPES.FIREFOX,
    generatorBaseBrowser: 'firefox',
    poolCompatibility: 'multi-only', // Real Gecko engine ONLY — never spoofed inside Chromium!
    fingerprintChromiumBrand: null,
    openSourceAntiDetect: true,
    sendsClientHints: false, // CRITICAL: Real Firefox NEVER sends sec-ch-ua* headers!
    supportsZstd: true,
    supportedOs: ['windows', 'macos', 'linux'],
    versions: [
      { major: '133', full: '133.0', tlsClientId: 'firefox_133' },
      { major: '132', full: '132.0.2', tlsClientId: 'firefox_132' },
      { major: '123', full: '123.0.1', tlsClientId: 'firefox_123' },
    ],
  },
  {
    brandId: 'camoufox',
    displayName: 'Camoufox / LibreWolf Anti-Detect Gecko (Open-Source)',
    engine: ENGINE_TYPES.FIREFOX,
    generatorBaseBrowser: 'firefox',
    poolCompatibility: 'multi-only', // Runs on Camoufox C++ binary or real Playwright Gecko
    fingerprintChromiumBrand: null,
    openSourceAntiDetect: true,
    sendsClientHints: false, // CRITICAL: Gecko NEVER sends sec-ch-ua* headers!
    supportsZstd: true,
    supportedOs: ['windows', 'macos', 'linux'],
    versions: [
      { major: '133', full: '133.0', tlsClientId: 'firefox_133' },
      { major: '132', full: '132.0', tlsClientId: 'firefox_132' },
    ],
  },
  {
    brandId: 'safari',
    displayName: 'Apple Safari (WebKit)',
    engine: ENGINE_TYPES.WEBKIT,
    generatorBaseBrowser: 'safari',
    poolCompatibility: 'multi-only', // Real WebKit engine ONLY — never spoofed inside Chromium!
    fingerprintChromiumBrand: null,
    openSourceAntiDetect: false,
    sendsClientHints: false, // CRITICAL: Real Safari NEVER sends sec-ch-ua* headers!
    supportsZstd: false,     // Safari advertises gzip, deflate, br (no zstd)
    supportedOs: ['macos'],  // Desktop Safari only runs on macOS!
    versions: [
      { major: '17', full: '17.6', webkitBuild: '605.1.15', tlsClientId: 'safari_16_0' },
      { major: '16', full: '16.6', webkitBuild: '605.1.15', tlsClientId: 'safari_16_0' },
      { major: '15.6', full: '15.6.1', webkitBuild: '605.1.15', tlsClientId: 'safari_15_6_1' },
    ],
  },
]);

function getBrandSpec(brandId) {
  const found = BROWSER_BRAND_CATALOG.find((b) => b.brandId === brandId);
  if (!found) {
    throw new Error(
      `Unknown browser brand "${brandId}". Valid brands: ${BROWSER_BRAND_CATALOG.map((b) => b.brandId).join(', ')}`
    );
  }
  return found;
}

/**
 * Filter available browser brands based on active rotation mode and available engines.
 *   - 'single-engine': Returns the 6 Chromium-based brands (Chrome, Edge, Opera, Brave, Vivaldi, Ungoogled-Chromium)
 *   - 'multi-engine' or 'hybrid': Returns all brands whose engine is in `enabledEngines`
 */
function listBrandsForMode(mode = 'hybrid', enabledEngines = ['chromium', 'firefox', 'webkit']) {
  const engineSet = new Set(enabledEngines);
  if (mode === 'single-engine') {
    return BROWSER_BRAND_CATALOG.filter((b) => b.poolCompatibility === 'single-or-multi');
  }
  return BROWSER_BRAND_CATALOG.filter((b) => engineSet.has(b.engine));
}

/**
 * Expand all discrete `(brandId, version, os)` variant combinations in the catalog
 * (useful for Phase 2's anti-collision LeaseManager when worker count > 9).
 */
function enumerateAllCatalogVariants(mode = 'hybrid', enabledEngines = ['chromium', 'firefox', 'webkit']) {
  const brands = listBrandsForMode(mode, enabledEngines);
  const variants = [];
  for (const brand of brands) {
    for (const ver of brand.versions) {
      const allowedOs = ver.supportedOs || brand.supportedOs;
      for (const os of allowedOs) {
        if (!brand.supportedOs.includes(os)) continue;
        variants.push({
          variantKey: `${brand.brandId}:${ver.major}:${os}`,
          brandId: brand.brandId,
          displayName: brand.displayName,
          engine: brand.engine,
          os,
          versionSpec: ver,
          brandSpec: brand,
        });
      }
    }
  }
  return variants;
}

const BROWSER_CATALOG = Object.freeze(
  Object.fromEntries(BROWSER_BRAND_CATALOG.map((b) => [b.brandId, b]))
);

module.exports = {
  ENGINE_TYPES,
  SUPPORTED_TLS_IDENTIFIERS,
  OS_GPU_CATALOG,
  GECKO_WEBKIT_GPU_CATALOG,
  DESKTOP_RESOLUTIONS,
  LOCALE_TIMEZONE_PRESETS,
  BROWSER_BRAND_CATALOG,
  BROWSER_CATALOG,
  getBrandSpec,
  listBrandsForMode,
  enumerateAllCatalogVariants,
};
