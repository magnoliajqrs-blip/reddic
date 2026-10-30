'use strict';

/**
 * Phase 1 — Cryptographic Browser Fingerprint Synthesizer (`FingerprintSynthesizer.js`)
 *
 * Combines:
 *   1. Apify `fingerprint-generator` & `fingerprint-injector` Bayesian statistical models (when installed)
 *   2. Exact brand-level & engine-level synthesis for all 9 catalog browsers:
 *      Chrome, Edge, Opera, Brave, Vivaldi, Ungoogled/Fingerprint-Chromium, Firefox, Camoufox, Safari
 *   3. OS-locked WebGL GPU, Screen, Navigator, Client-Hints, and C++ `fingerprint-chromium` CLI flags
 *   4. Per-lease 64-bit cryptographic seed so every worker session has unique Canvas/Audio/DOMRects noise
 */

const crypto = require('crypto');
const {
  ENGINE_TYPES,
  OS_GPU_CATALOG,
  GECKO_WEBKIT_GPU_CATALOG,
  DESKTOP_RESOLUTIONS,
  LOCALE_TIMEZONE_PRESETS,
  getBrandSpec,
} = require('./ProfileCatalog');

// Optional load of Apify fingerprint-suite (graceful fallback if node_modules not installed)
let FingerprintGenerator = null;
let FingerprintInjector = null;
try {
  ({ FingerprintGenerator } = require('fingerprint-generator'));
  ({ FingerprintInjector } = require('fingerprint-injector'));
} catch {
  // Fallback mode remains 100% functional
}

let _sharedGenerator = null;
let _sharedInjector = null;

function getSharedGenerator() {
  if (!_sharedGenerator && FingerprintGenerator) {
    _sharedGenerator = new FingerprintGenerator({
      devices: ['desktop'],
      httpVersion: '2',
      slim: true,
    });
  }
  return _sharedGenerator;
}

function getSharedInjector() {
  if (!_sharedInjector && FingerprintInjector) {
    _sharedInjector = new FingerprintInjector();
  }
  return _sharedInjector;
}

/**
 * Deterministic PRNG seeded from an 8-byte Buffer (allows reproducible debug replays
 * while guaranteeing cryptographic uniqueness across fresh seeds).
 */
class SeededRng {
  constructor(seedHex = null) {
    this.seedBuffer = seedHex
      ? Buffer.from(String(seedHex).padEnd(16, '0').slice(0, 16), 'hex')
      : crypto.randomBytes(8);
    this.seedHex = this.seedBuffer.toString('hex');
    this.uint32Seed = this.seedBuffer.readUInt32BE(0);
    this._counter = 0;
  }

  nextUint32() {
    const h = crypto
      .createHash('sha256')
      .update(this.seedBuffer)
      .update(Buffer.from([
        (this._counter >>> 24) & 0xff,
        (this._counter >>> 16) & 0xff,
        (this._counter >>> 8) & 0xff,
        this._counter & 0xff,
      ]))
      .digest();
    this._counter += 1;
    return h.readUInt32BE(0);
  }

  nextInt(min, maxExclusive) {
    if (maxExclusive <= min) return min;
    return min + (this.nextUint32() % (maxExclusive - min));
  }

  pick(arr) {
    return arr[this.nextInt(0, arr.length)];
  }
}

function buildOsTokens(os, engine) {
  if (os === 'windows') {
    return {
      uaToken: 'Windows NT 10.0; Win64; x64',
      navigatorPlatform: 'Win32',
      chPlatform: 'Windows',
      chPlatformVersion: '15.0.0', // Windows 11 Client Hints version
      oscpu: engine === ENGINE_TYPES.FIREFOX ? 'Windows NT 10.0; Win64; x64' : undefined,
    };
  }
  if (os === 'macos') {
    return {
      uaToken: engine === ENGINE_TYPES.FIREFOX
        ? 'Macintosh; Intel Mac OS X 10.15'
        : 'Macintosh; Intel Mac OS X 10_15_7',
      navigatorPlatform: 'MacIntel',
      chPlatform: 'macOS',
      chPlatformVersion: '14.6.1',
      oscpu: engine === ENGINE_TYPES.FIREFOX ? 'Intel Mac OS X 10.15' : undefined,
    };
  }
  return {
    uaToken: engine === ENGINE_TYPES.FIREFOX
      ? 'X11; Ubuntu; Linux x86_64'
      : 'X11; Linux x86_64',
    navigatorPlatform: 'Linux x86_64',
    chPlatform: 'Linux',
    chPlatformVersion: '6.8.0',
    oscpu: engine === ENGINE_TYPES.FIREFOX ? 'Linux x86_64' : undefined,
  };
}

function buildExactUserAgent(brandSpec, verSpec, osTokens) {
  const { brandId } = brandSpec;
  const { uaToken } = osTokens;

  switch (brandId) {
    case 'chrome':
    case 'brave':
    case 'ungoogled_chromium':
      // Real Brave & Ungoogled-Chromium intentionally emit standard Chrome UA string to prevent UA fingerprinting
      return `Mozilla/5.0 (${uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${verSpec.major}.0.0.0 Safari/537.36`;

    case 'edge':
      return `Mozilla/5.0 (${uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${verSpec.chromiumMajor || verSpec.major}.0.0.0 Safari/537.36 Edg/${verSpec.major}.0.0.0`;

    case 'opera': {
      const chrMajor = verSpec.chromiumMajor || '130';
      return `Mozilla/5.0 (${uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrMajor}.0.0.0 Safari/537.36 OPR/${verSpec.major}.0.0.0`;
    }

    case 'vivaldi': {
      const chrMajor = verSpec.chromiumMajor || '130';
      return `Mozilla/5.0 (${uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrMajor}.0.0.0 Safari/537.36`;
    }

    case 'firefox':
    case 'camoufox':
      return `Mozilla/5.0 (${uaToken}; rv:${verSpec.major}.0) Gecko/20100101 Firefox/${verSpec.major}.0`;

    case 'safari':
      return `Mozilla/5.0 (${uaToken}) AppleWebKit/${verSpec.webkitBuild || '605.1.15'} (KHTML, like Gecko) Version/${verSpec.full} Safari/${verSpec.webkitBuild || '605.1.15'}`;

    default:
      throw new Error(`Unsupported brandId for UA construction: ${brandId}`);
  }
}

function buildUserAgentData(brandSpec, verSpec, osTokens) {
  if (!brandSpec.sendsClientHints) {
    // CRITICAL: Real Firefox, Camoufox, and Safari DO NOT expose navigator.userAgentData!
    return null;
  }

  const chrMajor = verSpec.chromiumMajor || verSpec.major;
  const chrFull = verSpec.chromiumFull || verSpec.full;
  const grease = { brand: verSpec.greaseBrand || 'Not_A Brand', version: verSpec.greaseVer || '24' };
  const greaseFull = { brand: grease.brand, version: `${grease.version}.0.0.0` };

  let brands;
  let fullVersionList;

  switch (brandSpec.brandId) {
    case 'chrome':
      brands = [
        { brand: 'Google Chrome', version: verSpec.major },
        { brand: 'Chromium', version: verSpec.major },
        grease,
      ];
      fullVersionList = [
        { brand: 'Google Chrome', version: verSpec.full },
        { brand: 'Chromium', version: verSpec.full },
        greaseFull,
      ];
      break;

    case 'edge':
      brands = [
        { brand: 'Microsoft Edge', version: verSpec.major },
        { brand: 'Chromium', version: chrMajor },
        grease,
      ];
      fullVersionList = [
        { brand: 'Microsoft Edge', version: verSpec.full },
        { brand: 'Chromium', version: `${chrMajor}.0.0.0` },
        greaseFull,
      ];
      break;

    case 'opera':
      brands = [
        { brand: 'Chromium', version: chrMajor },
        grease,
        { brand: 'Opera', version: verSpec.major },
      ];
      fullVersionList = [
        { brand: 'Chromium', version: chrFull },
        greaseFull,
        { brand: 'Opera', version: verSpec.full },
      ];
      break;

    case 'brave':
      brands = [
        { brand: 'Brave', version: verSpec.major },
        { brand: 'Chromium', version: verSpec.major },
        grease,
      ];
      fullVersionList = [
        { brand: 'Brave', version: verSpec.full },
        { brand: 'Chromium', version: verSpec.full },
        greaseFull,
      ];
      break;

    case 'vivaldi':
    case 'ungoogled_chromium':
    default:
      brands = [
        { brand: 'Chromium', version: chrMajor },
        grease,
      ];
      fullVersionList = [
        { brand: 'Chromium', version: chrFull },
        greaseFull,
      ];
      break;
  }

  return {
    brands,
    fullVersionList,
    mobile: false,
    platform: osTokens.chPlatform,
    platformVersion: osTokens.chPlatformVersion,
    architecture: 'x86',
    bitness: '64',
    model: '',
    uaFullVersion: verSpec.full,
  };
}

/**
 * Synthesize a complete, internally consistent browser profile + cryptographic noise seed.
 *
 * @param {object} options
 * @param {string} options.brandId - One of the 9 catalog brand IDs (e.g. 'chrome', 'firefox', 'opera', 'safari', 'brave', 'camoufox'...)
 * @param {string} [options.os] - Optional target OS ('windows' | 'macos' | 'linux'); auto-picked from brand's supportedOs if omitted
 * @param {string} [options.versionMajor] - Optional major version override
 * @param {string} [options.seedHex] - Optional 16-char hex seed (generates fresh crypto 64-bit seed if omitted)
 */
function synthesizeProfile({
  brandId = 'chrome',
  os = null,
  versionMajor = null,
  seedHex = null,
} = {}) {
  const rng = new SeededRng(seedHex);
  const brandSpec = getBrandSpec(brandId);

  const selectedOs =
    os && brandSpec.supportedOs.includes(os)
      ? os
      : rng.pick(brandSpec.supportedOs);

  const compatibleVersions = brandSpec.versions.filter(
    (v) => !v.supportedOs || v.supportedOs.includes(selectedOs)
  );
  const versionPool = compatibleVersions.length > 0 ? compatibleVersions : brandSpec.versions;
  const verSpec =
    (versionMajor && versionPool.find((v) => v.major === String(versionMajor))) ||
    rng.pick(versionPool);

  const osTokens = buildOsTokens(selectedOs, brandSpec.engine);
  const screenPreset = rng.pick(DESKTOP_RESOLUTIONS[selectedOs]);
  const localePreset = rng.pick(LOCALE_TIMEZONE_PRESETS);

  const gpuList =
    brandSpec.engine === ENGINE_TYPES.CHROMIUM
      ? OS_GPU_CATALOG[selectedOs]
      : GECKO_WEBKIT_GPU_CATALOG[selectedOs];
  const gpuSpec = rng.pick(gpuList);

  const hardwareConcurrency = rng.pick([4, 8, 12, 16]);
  // Firefox & Safari do NOT implement navigator.deviceMemory
  const deviceMemory =
    brandSpec.engine === ENGINE_TYPES.CHROMIUM ? rng.pick([8, 16, 32]) : undefined;

  // Query Apify Bayesian FingerprintGenerator for baseline codecs/fonts/plugins when available
  let bayesianBase = null;
  const gen = getSharedGenerator();
  if (gen) {
    try {
      bayesianBase = gen.getFingerprint({
        browsers: [{ name: brandSpec.generatorBaseBrowser }],
        operatingSystems: [selectedOs],
        devices: ['desktop'],
        locales: [localePreset.locale],
      });
    } catch {
      bayesianBase = null;
    }
  }

  const userAgent = buildExactUserAgent(brandSpec, verSpec, osTokens);
  const userAgentData = buildUserAgentData(brandSpec, verSpec, osTokens);

  const vendor =
    brandSpec.engine === ENGINE_TYPES.CHROMIUM
      ? 'Google Inc.'
      : brandSpec.engine === ENGINE_TYPES.WEBKIT
      ? 'Apple Computer, Inc.'
      : ''; // Gecko vendor is empty string ""

  // Subtle cryptographic noise parameters unique to this lease
  const noiseSpec = {
    seedHex: rng.seedHex,
    uint32Seed: rng.uint32Seed,
    canvasRDelta: (rng.nextInt(1, 4)) * (rng.nextInt(0, 2) === 0 ? 1 : -1),
    canvasGDelta: (rng.nextInt(0, 3)) * (rng.nextInt(0, 2) === 0 ? 1 : -1),
    audioEpsilon: Number(((rng.nextInt(1, 9) * 1e-7)).toFixed(9)),
    domRectEpsilon: Number(((rng.nextInt(1, 7) * 1e-4)).toFixed(6)),
  };

  // Native CLI flags for open-source C++ `adryfish/fingerprint-chromium` when binary is configured
  const fingerprintChromiumArgs =
    brandSpec.engine === ENGINE_TYPES.CHROMIUM
      ? [
          `--fingerprint=${noiseSpec.uint32Seed}`,
          `--fingerprint-brand=${brandSpec.fingerprintChromiumBrand || 'Chrome'}`,
          `--fingerprint-platform=${selectedOs === 'macos' ? 'macos' : selectedOs === 'linux' ? 'linux' : 'windows'}`,
          `--lang=${localePreset.locale}`,
        ]
      : [];

  const screen = {
    width: screenPreset.width,
    height: screenPreset.height,
    availWidth: screenPreset.width,
    availHeight: screenPreset.height - screenPreset.availHeightDrop,
    devicePixelRatio: screenPreset.dpr,
    colorDepth: 24,
    pixelDepth: 24,
  };

  const navigatorSpec = {
    userAgent,
    userAgentData,
    platform: osTokens.navigatorPlatform,
    vendor,
    oscpu: osTokens.oscpu,
    language: localePreset.locale,
    languages: localePreset.languages,
    hardwareConcurrency,
    deviceMemory,
    maxTouchPoints: 0,
    webdriver: false,
    pdfViewerEnabled: true,
  };

  // Unique composite signature hash for Phase 2 LeaseManager collision tracking
  const variantKey = `${brandSpec.brandId}:${verSpec.major}:${selectedOs}`;
  const hardwareKey = `${variantKey}:${screen.width}x${screen.height}:${gpuSpec.renderer}`;
  const signatureId = crypto
    .createHash('sha256')
    .update(`${hardwareKey}:${noiseSpec.seedHex}`)
    .digest('hex')
    .slice(0, 16);

  return {
    signatureId,
    variantKey,
    hardwareKey,
    brandId: brandSpec.brandId,
    displayName: brandSpec.displayName,
    engine: brandSpec.engine,
    poolCompatibility: brandSpec.poolCompatibility,
    openSourceAntiDetect: brandSpec.openSourceAntiDetect,
    os: selectedOs,
    versionMajor: verSpec.major,
    versionFull: verSpec.full,
    tlsClientId: verSpec.tlsClientId,
    sendsClientHints: brandSpec.sendsClientHints,
    supportsZstd: brandSpec.supportsZstd,
    locale: localePreset.locale,
    languages: localePreset.languages,
    timezoneId: localePreset.timezoneId,
    tzOffsetMin: localePreset.tzOffsetMin,
    screen,
    gpu: gpuSpec,
    navigator: navigatorSpec,
    noise: noiseSpec,
    fingerprintChromiumArgs,
    bayesianFingerprint: bayesianBase || null,
  };
}

/**
 * Generates a lightweight, engine-safe JavaScript initialization script to align browser context
 * properties (WebGL vendor/renderer, brand-specific globals like `navigator.brave` / `window.opr`,
 * navigator hardware fields, and deterministic per-seed Canvas/Audio noise).
 *
 * Designed so it NEVER injects Chromium-only APIs (`userAgentData`, `deviceMemory`, `window.chrome`)
 * into Firefox/Camoufox or Safari/WebKit!
 */
function buildContextInitScript(profile) {
  const payload = JSON.stringify({
    brandId: profile.brandId,
    engine: profile.engine,
    navigator: profile.navigator,
    screen: profile.screen,
    gpu: profile.gpu,
    noise: profile.noise,
  });

  return `(() => {
    const cfg = ${payload};
    const def = (obj, prop, getter) => {
      try {
        Object.defineProperty(obj, prop, { get: getter, configurable: true, enumerable: true });
      } catch (_) {}
    };

    const navProto = Object.getPrototypeOf(navigator);
    def(navProto, 'webdriver', () => false);
    def(navProto, 'platform', () => cfg.navigator.platform);
    def(navProto, 'vendor', () => cfg.navigator.vendor);
    def(navProto, 'language', () => cfg.navigator.language);
    def(navProto, 'languages', () => Object.freeze([...cfg.navigator.languages]));
    def(navProto, 'hardwareConcurrency', () => cfg.navigator.hardwareConcurrency);
    def(navProto, 'maxTouchPoints', () => 0);

    if (cfg.engine === 'firefox' && cfg.navigator.oscpu) {
      def(navProto, 'oscpu', () => cfg.navigator.oscpu);
    }

    if (cfg.engine === 'chromium') {
      if (cfg.navigator.deviceMemory !== undefined) {
        def(navProto, 'deviceMemory', () => cfg.navigator.deviceMemory);
      }
      if (cfg.navigator.userAgentData) {
        const uad = cfg.navigator.userAgentData;
        const mockUad = {
          brands: Object.freeze(uad.brands.map(b => Object.freeze({ ...b }))),
          mobile: false,
          platform: uad.platform,
          getHighEntropyValues: async (hints = []) => {
            const out = { brands: uad.brands, mobile: false, platform: uad.platform };
            for (const h of hints) {
              if (h in uad) out[h] = uad[h];
            }
            return out;
          },
          toJSON: () => ({ brands: uad.brands, mobile: false, platform: uad.platform }),
        };
        def(navProto, 'userAgentData', () => mockUad);
      }
      if (cfg.brandId === 'brave' && !navigator.brave) {
        def(navProto, 'brave', () => Object.freeze({ isBrave: async () => true }));
      }
      if (cfg.brandId === 'opera' && !window.opr) {
        try { window.opr = { addons: {} }; } catch (_) {}
      }
    }

    // WebGL Vendor & Renderer alignment (UNMASKED_VENDOR_WEBGL = 37445, UNMASKED_RENDERER_WEBGL = 37446)
    const debugRendererExt = Object.freeze({
      UNMASKED_VENDOR_WEBGL: 37445,
      UNMASKED_RENDERER_WEBGL: 37446,
    });
    const patchWebGL = (proto) => {
      if (!proto || !proto.getParameter) return;
      const origGetParam = proto.getParameter;
      Object.defineProperty(proto, 'getParameter', {
        value: function(param) {
          if (param === 37445) return cfg.gpu.vendor;
          if (param === 37446) return cfg.gpu.renderer;
          return origGetParam.apply(this, arguments);
        },
        configurable: true,
        writable: true,
      });
      if (proto.getExtension) {
        const origGetExt = proto.getExtension;
        Object.defineProperty(proto, 'getExtension', {
          value: function(name) {
            const res = origGetExt.apply(this, arguments);
            if (!res && name === 'WEBGL_debug_renderer_info') return debugRendererExt;
            return res;
          },
          configurable: true,
          writable: true,
        });
      }
    };
    if (typeof WebGLRenderingContext !== 'undefined') patchWebGL(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext.prototype);

    // Headless GPU-less container fallback (e.g. Firefox headless on Linux VPS without Mesa EGL)
    if (typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype.getContext) {
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        value: function(type, ...rest) {
          const ctx = origGetContext.apply(this, [type, ...rest]);
          if (ctx) return ctx;
          if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
            return {
              canvas: this,
              drawingBufferWidth: this.width || 300,
              drawingBufferHeight: this.height || 150,
              getExtension: (name) => (name === 'WEBGL_debug_renderer_info' ? debugRendererExt : null),
              getSupportedExtensions: () => ['WEBGL_debug_renderer_info'],
              getParameter: (param) => {
                if (param === 37445) return cfg.gpu.vendor;
                if (param === 37446) return cfg.gpu.renderer;
                if (param === 7936) return 'WebKit';
                if (param === 7937) return 'WebKit WebGL';
                if (param === 7938) return 'WebGL 1.0';
                return null;
              },
            };
          }
          return ctx;
        },
        configurable: true,
        writable: true,
      });
    }

    // W12: strengthened per-seed Canvas 2D noise — previously a SINGLE 1-pixel LSB shift (weak
    // against modern canvas fingerprinting surfaces). Now 4-9 deterministic pixels, each with
    // its own R/G channel delta derived from the lease seed (still 100% reproducible per lease).
    if (typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype.toDataURL) {
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
        value: function(...args) {
          try {
            const ctx = this.getContext && this.getContext('2d');
            if (ctx && this.width > 8 && this.height > 8) {
              const seed = cfg.noise.uint32Seed >>> 0;
              const pixelCount = 4 + (seed % 6); // 4..9 pixels
              for (let n = 0; n < pixelCount; n++) {
                const mix = (Math.imul(seed ^ (n * 0x9E3779B9), 2654435761) >>> 0);
                const px = mix % (this.width - 1);
                const py = (mix >>> 8) % (this.height - 1);
                const img = ctx.getImageData(px, py, 1, 1);
                const rDelta = ((mix >>> 16) % 3) - 1 + cfg.noise.canvasRDelta;
                const gDelta = ((mix >>> 20) % 3) - 1 + (cfg.noise.canvasGDelta || 0);
                img.data[0] = Math.max(0, Math.min(255, img.data[0] + rDelta));
                img.data[1] = Math.max(0, Math.min(255, img.data[1] + gDelta));
                ctx.putImageData(img, px, py);
              }
            }
          } catch (_) {}
          return origToDataURL.apply(this, args);
        },
        configurable: true,
        writable: true,
      });

      // W12b: subtle per-seed text-metrics micro-variance on canvas measureText (deterministic
      // per lease, tiny enough to never break page layouts).
      if (typeof CanvasRenderingContext2D !== 'undefined' && CanvasRenderingContext2D.prototype.measureText) {
        const origMeasure = CanvasRenderingContext2D.prototype.measureText;
        const eps = ((cfg.noise.uint32Seed % 7) - 3) * 0.01; // -0.03..+0.03 px
        if (eps !== 0) {
          Object.defineProperty(CanvasRenderingContext2D.prototype, 'measureText', {
            value: function(text) {
              const m = origMeasure.call(this, text);
              try {
                Object.defineProperty(m, 'width', { get: () => m._w ?? (m._w = origMeasure.call(this, text).width + eps) });
              } catch (_) {}
              return m;
            },
            configurable: true,
            writable: true,
          });
        }
      }
    }
  })();`;
}

module.exports = {
  SeededRng,
  synthesizeProfile,
  buildContextInitScript,
  getSharedGenerator,
  getSharedInjector,
};
