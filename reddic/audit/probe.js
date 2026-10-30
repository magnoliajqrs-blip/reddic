/*
 * reddic — in-browser signal collector
 * ------------------------------------
 * This file is a single JS *expression*:  async () => ({ ...signals })
 *
 * Two ways it is used:
 *   1. lab   -> served at /probe.js, evaluated by the lab page
 *   2. audit -> string-concatenated and passed to engine evaluate()
 *
 * Design rule: this file only COLLECTS. All judgement lives in Python
 * (reddic/audit/checks.py) so that rules stay unit-testable against
 * captured fixtures.
 *
 * Every probe is wrapped: one broken API must never kill the run.
 */
async () => {
  const PROBE_VERSION = "1.0.0";
  const t0 = performance.now();
  const errors = [];

  const safe = (label, fn, fallback = null) => {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch (e) {
      errors.push(label + ": " + String(e).slice(0, 160));
      return fallback;
    }
  };
  const safeAsync = async (label, fn, fallback = null) => {
    try {
      const v = await fn();
      return v === undefined ? fallback : v;
    } catch (e) {
      errors.push(label + ": " + String(e).slice(0, 160));
      return fallback;
    }
  };
  const fnv = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  };
  let seededRandom = null;
  try {
    const c = document.createElement("canvas");
    c.width = 8;
    c.height = 8;
    const g = c.getContext("2d");
    const d = g.getImageData(0, 0, 8, 8).data;
    let s = 0;
    for (let i = 0; i < d.length; i++) s = (s + d[i]) % 100003;
    seededRandom = s;
  } catch (e) {
    /* ignore */
  }

  const out = {
    meta: {},
    navigator: {},
    uaData: null,
    screen: {},
    window: {},
    intl: {},
    canvas: null,
    offscreen: null,
    webgl: {},
    audio: null,
    fonts: {},
    media: {},
    webrtc: {},
    permissions: {},
    chrome: {},
    automation: {},
    storage: {},
    connection: {},
    speech: {},
    battery: null,
    timing: {},
    errors,
  };

  /* ------------------------------------------------------------------ meta */
  out.meta = {
    probeVersion: PROBE_VERSION,
    timestamp: new Date().toISOString(),
    url: safe("meta.url", () => location.href),
    origin: safe("meta.origin", () => location.origin),
    hostname: safe("meta.hostname", () => location.hostname),
    referrer: safe("meta.referrer", () => document.referrer),
    secureContext: safe("meta.secureContext", () => window.isSecureContext),
    crossOriginIsolated: safe("meta.crossOriginIsolated", () => window.crossOriginIsolated),
    userAgentDataSupported: safe("meta.uachSupported", () => "userAgentData" in navigator),
    seededRandom,
  };

  /* ------------------------------------------------------------- navigator */
  const nav = navigator;
  out.navigator = {
    userAgent: safe("nav.userAgent", () => nav.userAgent),
    appVersion: safe("nav.appVersion", () => nav.appVersion),
    appName: safe("nav.appName", () => nav.appName),
    appCodeName: safe("nav.appCodeName", () => nav.appCodeName),
    product: safe("nav.product", () => nav.product),
    productSub: safe("nav.productSub", () => nav.productSub),
    vendor: safe("nav.vendor", () => nav.vendor),
    vendorSub: safe("nav.vendorSub", () => nav.vendorSub),
    platform: safe("nav.platform", () => nav.platform),
    language: safe("nav.language", () => nav.language),
    languages: safe("nav.languages", () => Array.from(nav.languages || [])),
    hardwareConcurrency: safe("nav.hardwareConcurrency", () => nav.hardwareConcurrency),
    deviceMemory: safe("nav.deviceMemory", () => nav.deviceMemory),
    maxTouchPoints: safe("nav.maxTouchPoints", () => nav.maxTouchPoints),
    webdriver: safe("nav.webdriver", () => nav.webdriver),
    cookieEnabled: safe("nav.cookieEnabled", () => nav.cookieEnabled),
    doNotTrack: safe("nav.doNotTrack", () => nav.doNotTrack),
    pdfViewerEnabled: safe("nav.pdfViewerEnabled", () => nav.pdfViewerEnabled),
    onLine: safe("nav.onLine", () => nav.onLine),
    plugins: safe("nav.plugins", () => Array.from(nav.plugins || []).map((p) => (p ? p.name : null))),
    mimeTypes: safe("nav.mimeTypes", () => (nav.mimeTypes ? nav.mimeTypes.length : null)),
    globalPrivacyControl: safe("nav.gpc", () => nav.globalPrivacyControl),
    webdriverInNavigator: safe("nav.hasWebdriver", () => "webdriver" in navigator),
  };

  /* ---------------------------------------------------------- client hints */
  if (nav.userAgentData) {
    const high = await safeAsync(
      "uach.high",
      () =>
        nav.userAgentData.getHighEntropyValues([
          "architecture",
          "bitness",
          "formFactors",
          "fullVersionList",
          "model",
          "platform",
          "platformVersion",
          "uaFullVersion",
          "wow64",
        ]),
      null
    );
    out.uaData = {
      brands: safe("uach.brands", () => nav.userAgentData.brands),
      mobile: safe("uach.mobile", () => nav.userAgentData.mobile),
      platform: safe("uach.platform", () => nav.userAgentData.platform),
      high,
    };
  }

  /* -------------------------------------------------------- screen/window */
  const scr = screen;
  out.screen = {
    width: safe("screen.width", () => scr.width),
    height: safe("screen.height", () => scr.height),
    availWidth: safe("screen.availWidth", () => scr.availWidth),
    availHeight: safe("screen.availHeight", () => scr.availHeight),
    availLeft: safe("screen.availLeft", () => scr.availLeft),
    availTop: safe("screen.availTop", () => scr.availTop),
    colorDepth: safe("screen.colorDepth", () => scr.colorDepth),
    pixelDepth: safe("screen.pixelDepth", () => scr.pixelDepth),
    orientation: safe("screen.orientation", () => (scr.orientation ? scr.orientation.type : null)),
    isExtended: safe("screen.isExtended", () => scr.isExtended),
  };
  out.window = {
    innerWidth: safe("win.innerWidth", () => window.innerWidth),
    innerHeight: safe("win.innerHeight", () => window.innerHeight),
    outerWidth: safe("win.outerWidth", () => window.outerWidth),
    outerHeight: safe("win.outerHeight", () => window.outerHeight),
    screenX: safe("win.screenX", () => window.screenX),
    screenY: safe("win.screenY", () => window.screenY),
    devicePixelRatio: safe("win.dpr", () => window.devicePixelRatio),
    hasFocus: safe("win.hasFocus", () => document.hasFocus()),
    visualViewportScale: safe("win.vv", () => (window.visualViewport ? window.visualViewport.scale : null)),
    innerEqualsOuter: safe("win.equal", () => window.innerWidth === window.outerWidth),
    chromeKeysOnWindow: safe("win.chromeKeys", () => (window.chrome ? Object.getOwnPropertyNames(window.chrome) : [])),
  };

  /* ----------------------------------------------------------------- intl */
  out.intl = await safeAsync(
    "intl",
    () => {
      const dtf = new Intl.DateTimeFormat();
      const ro = dtf.resolvedOptions();
      let localeList = null;
      try {
        localeList = Intl.DateTimeFormat.supportedLocalesOf(["en-US", "en-GB", "bn-BD", "de-DE"]).join(",");
      } catch (e) {
        /* ignore */
      }
      return {
        timeZone: ro.timeZone,
        locale: ro.locale,
        calendar: ro.calendar,
        numberingSystem: ro.numberingSystem,
        hourCycle: ro.hourCycle,
        timeZoneOffset: new Date().getTimezoneOffset(),
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
        dateSample: dtf.format(new Date(Date.UTC(2020, 0, 1, 12, 0, 0))),
        numberSample: new Intl.NumberFormat().format(1234567.891),
        collatorLocale: new Intl.Collator().resolvedOptions().locale,
        supportedLocales: localeList,
        intlVersion: typeof Intl !== "undefined" ? "present" : null,
      };
    },
    {}
  );

  /* --------------------------------------------------------------- canvas */
  const canvasProbe = (seed) => {
    const c = document.createElement("canvas");
    c.width = 260;
    c.height = 70;
    const ctx = c.getContext("2d");
    if (!ctx) return { ok: false, reason: "no 2d context" };
    ctx.textBaseline = "top";
    ctx.font = '14px "Arial"';
    ctx.fillStyle = "#f60";
    ctx.fillRect(0, 0, 260, 70);
    ctx.fillStyle = "#069";
    ctx.fillText("reddic " + seed + " 0123456789", 2, 2);
    ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
    ctx.fillText("fingerprint \u2318 \u00e9\u00e8\u00ea \u4f60\u597d", 4, 20);
    ctx.font = '11px "Times New Roman"';
    ctx.fillStyle = "#333";
    ctx.fillText("CwKo 1lI| @#$%^&*()", 4, 40);
    const grad = ctx.createLinearGradient(0, 0, 260, 70);
    grad.addColorStop(0, "#fff");
    grad.addColorStop(0.5, "#8a2be2");
    grad.addColorStop(1, "#000");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 54, 260, 16);
    const url = c.toDataURL();
    return { ok: true, hash: fnv(url), length: url.length, dataUrl: url };
  };
  const cv1 = safe("canvas.1", () => canvasProbe("A"), { ok: false });
  const cv2 = safe("canvas.2", () => canvasProbe("A"), { ok: false });
  const cv3 = safe("canvas.3", () => canvasProbe("B"), { ok: false });
  if (cv1 && cv1.ok) {
    out.canvas = {
      ok: true,
      hash: cv1.hash,
      hashB: cv3 && cv3.ok ? cv3.hash : null,
      length: cv1.length,
      stableSameDraw: cv1.hash === (cv2 ? cv2.hash : null),
      differsOnDifferentDraw: cv1.hash !== (cv3 ? cv3.hash : null),
      dataUrlHead: cv1.dataUrl.slice(0, 120),
      dataUrl: cv1.dataUrl.length < 12000 ? cv1.dataUrl : null,
    };
  } else {
    out.canvas = { ok: false };
  }

  out.offscreen = await safeAsync(
    "offscreen",
    () => {
      if (typeof OffscreenCanvas === "undefined") return { supported: false };
      const c = new OffscreenCanvas(64, 32);
      const g = c.getContext("2d");
      g.fillStyle = "#123456";
      g.fillRect(0, 0, 64, 32);
      g.font = "12px Arial";
      g.fillText("off", 2, 12);
      const blob = c.convertToBlob ? "async" : "none";
      const d = g.getImageData(0, 0, 64, 32).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 7) s = (s * 31 + d[i]) % 1000003;
      return { supported: true, hash: fnv(String(s)), convertToBlob: blob };
    },
    { supported: null }
  );

  /* ---------------------------------------------------------------- webgl */
  out.webgl = safe(
    "webgl",
    () => {
      const r = { supported: false };
      const c = document.createElement("canvas");
      let gl = null;
      let ver = null;
      try {
        gl = c.getContext("webgl2");
        ver = gl ? 2 : null;
      } catch (e) {
        /* ignore */
      }
      if (!gl) {
        try {
          gl = c.getContext("webgl") || c.getContext("experimental-webgl");
          ver = gl ? 1 : null;
        } catch (e) {
          /* ignore */
        }
      }
      if (!gl) return { supported: false };
      r.supported = true;
      r.contextVersion = ver;
      r.version = gl.getParameter(gl.VERSION);
      r.shadingLanguageVersion = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
      r.vendor = gl.getParameter(gl.VENDOR);
      r.renderer = gl.getParameter(gl.RENDERER);
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      r.debugInfoAvailable = !!dbg;
      r.unmaskedVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
      r.unmaskedRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
      r.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      r.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
      r.maxViewportDims = Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []);
      r.aliasedLineWidthRange = Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE) || []);
      r.aliasedPointSizeRange = Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || []);
      r.extensions = (gl.getSupportedExtensions() || []).slice().sort();
      r.extensionCount = r.extensions.length;
      const p = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT);
      r.vertexHighFloat = p ? { precision: p.precision, rangeMin: p.rangeMin, rangeMax: p.rangeMax } : null;
      return r;
    },
    { supported: false }
  );

  /* ---------------------------------------------------------------- audio */
  out.audio = await safeAsync(
    "audio",
    async () => {
      const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!AC) return { ok: false, reason: "no OfflineAudioContext" };
      const ctx = new AC(1, 44100, 44100);
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = 10000;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -50;
      comp.knee.value = 40;
      comp.ratio.value = 12;
      comp.attack.value = 0;
      comp.release.value = 0.25;
      osc.connect(comp);
      comp.connect(ctx.destination);
      osc.start(0);
      const buf = await ctx.startRendering();
      const d = buf.getChannelData(0);
      let sum = 0;
      for (let i = 4500; i < 5000 && i < d.length; i++) sum += Math.abs(d[i]);
      return { ok: true, hash: sum.toFixed(6), sampleRate: buf.sampleRate };
    },
    { ok: false }
  );

  /* ---------------------------------------------------------------- fonts */
  const FONT_LIST = [
    "Arial", "Arial Black", "Arial Narrow", "Calibri", "Cambria", "Candara",
    "Comic Sans MS", "Consolas", "Constantia", "Corbel", "Courier New",
    "Ebrima", "Franklin Gothic Medium", "Gabriola", "Georgia", "Impact",
    "Lucida Console", "Lucida Sans Unicode", "Malgun Gothic", "Microsoft Sans Serif",
    "Microsoft YaHei", "MS Gothic", "Palatino Linotype", "Segoe Print",
    "Segoe Script", "Segoe UI", "Segoe UI Emoji", "Segoe UI Symbol",
    "SimSun", "Sylfaen", "Tahoma", "Times New Roman", "Trebuchet MS",
    "Verdana", "Webdings", "Wingdings", "Helvetica", "Helvetica Neue",
    "Menlo", "Monaco", "Optima", "San Francisco", "Ubuntu", "DejaVu Sans",
    "Liberation Sans", "Noto Sans", "Roboto", "Cantarell", "Fira Sans",
  ];
  out.fonts = safe(
    "fonts",
    () => {
      const measured = [];
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) return { supported: false, detected: [] };
      const base = ["monospace", "sans-serif", "serif"];
      const baseWidth = {};
      const sample = "mmmmmmmmmmlli1|WwQ@#\u00e9";
      for (const b of base) {
        ctx.font = "72px " + b;
        baseWidth[b] = ctx.measureText(sample).width;
      }
      for (const f of FONT_LIST) {
        let hit = false;
        for (const b of base) {
          ctx.font = "72px '" + f + "', " + b;
          const w = ctx.measureText(sample).width;
          if (Math.abs(w - baseWidth[b]) > 0.5) {
            hit = true;
            break;
          }
        }
        if (hit) measured.push(f);
      }
      return {
        supported: true,
        detected: measured,
        count: measured.length,
        tested: FONT_LIST.length,
        genericWidths: baseWidth,
      };
    },
    { supported: false, detected: [] }
  );

  /* ---------------------------------------------------------------- media */
  out.media = await safeAsync(
    "media",
    async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return { supported: false, counts: {}, labeled: 0 };
      }
      const devs = await navigator.mediaDevices.enumerateDevices();
      const counts = {};
      let labeled = 0;
      for (const d of devs) {
        counts[d.kind] = (counts[d.kind] || 0) + 1;
        if (d.label) labeled++;
      }
      return { supported: true, total: devs.length, counts, labeled };
    },
    { supported: false, counts: {}, labeled: 0 }
  );

  /* --------------------------------------------------------------- webrtc */
  out.webrtc = await safeAsync(
    "webrtc",
    () =>
      new Promise((resolve) => {
        const r = { supported: !!window.RTCPeerConnection, candidates: [], ended: false };
        if (!r.supported) return resolve(r);
        let pc;
        const finish = () => {
          if (r.ended) return;
          r.ended = true;
          try {
            pc.close();
          } catch (e) {
            /* ignore */
          }
          resolve(r);
        };
        try {
          pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          });
        } catch (e) {
          r.error = String(e);
          return resolve(r);
        }
        const timer = setTimeout(finish, 3000);
        pc.onicecandidate = (e) => {
          if (!e.candidate || !e.candidate.candidate) {
            clearTimeout(timer);
            return finish();
          }
          r.candidates.push(e.candidate.candidate);
        };
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(timer);
            finish();
          }
        };
        try {
          pc.createDataChannel("probe");
          pc.createOffer()
            .then((o) => pc.setLocalDescription(o))
            .catch((err) => {
              r.error = String(err);
            });
        } catch (e) {
          r.error = String(e);
          resolve(r);
        }
      }),
    { supported: false, candidates: [] }
  );

  /* ---------------------------------------------------------- permissions */
  out.permissions = await safeAsync(
    "permissions",
    async () => {
      const names = [
        "geolocation", "notifications", "camera", "microphone", "clipboard-read",
        "clipboard-write", "persistent-storage", "push", "midi", "background-sync",
        "accelerometer", "gyroscope", "magnetometer", "screen-wake-lock", "storage-access",
      ];
      const res = {};
      if (!navigator.permissions || !navigator.permissions.query) {
        return { supported: false, states: res, notificationPermission: null };
      }
      for (const n of names) {
        try {
          const s = await navigator.permissions.query({ name: n });
          res[n] = s.state;
        } catch (e) {
          res[n] = "unsupported";
        }
      }
      let np = null;
      try {
        np = typeof Notification !== "undefined" ? Notification.permission : null;
      } catch (e) {
        np = "throws";
      }
      return { supported: true, states: res, notificationPermission: np };
    },
    { supported: false, states: {} }
  );

  /* ---------------------------------------------------------------- chrome */
  out.chrome = safe(
    "chrome",
    () => {
      const ch = window.chrome;
      let runtimeId = null;
      try {
        runtimeId = ch && ch.runtime ? ch.runtime.id || null : null;
      } catch (e) {
        runtimeId = "throws";
      }
      return {
        present: !!ch,
        typeofChrome: typeof ch,
        keys: ch ? Object.getOwnPropertyNames(ch) : [],
        hasRuntime: !!(ch && ch.runtime),
        runtimeId,
        hasApp: !!(ch && ch.app),
        hasCsi: !!(ch && typeof ch.csi === "function"),
        hasLoadTimes: !!(ch && typeof ch.loadTimes === "function"),
      };
    },
    { present: false }
  );

  /* ------------------------------------------------------------ automation */
  const cdpConsoleProbe = async () => {
    // If CDP Runtime.enable is active, the debugger serialises logged
    // objects and touches getters. Without a debugger attached, nothing
    // enumerates the object, so the getter never fires.
    try {
      let fired = false;
      const obj = {};
      Object.defineProperty(obj, "reddicCanary", {
        get() {
          fired = true;
          return 1;
        },
        enumerable: true,
        configurable: true,
      });
      console.debug(obj);
      await new Promise((r) => setTimeout(r, 50));
      return { leaked: fired };
    } catch (e) {
      return { leaked: null, error: String(e) };
    }
  };

  const stackProbe = () => {
    try {
      throw new Error("reddic-probe");
    } catch (e) {
      return String(e.stack || "").slice(0, 1200);
    }
  };

  const iframeRealm = () => {
    try {
      const f = document.createElement("iframe");
      f.style.cssText = "display:none;width:10px;height:10px";
      document.documentElement.appendChild(f);
      const w = f.contentWindow;
      const res = {
        ok: true,
        userAgent: w.navigator.userAgent,
        platform: w.navigator.platform,
        webdriver: w.navigator.webdriver,
        plugins: w.navigator.plugins ? w.navigator.plugins.length : null,
        languages: Array.from(w.navigator.languages || []),
        hardwareConcurrency: w.navigator.hardwareConcurrency,
        hasChrome: !!w.chrome,
        outerWidth: w.outerWidth,
        outerHeight: w.outerHeight,
        deviceMemory: w.navigator.deviceMemory,
      };
      f.remove();
      return res;
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  };

  const workerRealm = () =>
    new Promise((resolve) => {
      try {
        const src =
          "postMessage({" +
          "userAgent: navigator.userAgent," +
          "platform: navigator.platform," +
          "webdriver: navigator.webdriver === true," +
          "hardwareConcurrency: navigator.hardwareConcurrency," +
          "deviceMemory: navigator.deviceMemory || null," +
          "languages: Array.from(navigator.languages || [])," +
          "origin: self.origin," +
          "hasImportScripts: typeof importScripts === 'function'" +
          "});";
        const blob = new Blob([src], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        const w = new Worker(url);
        const timer = setTimeout(() => {
          try {
            w.terminate();
          } catch (e) {
            /* ignore */
          }
          URL.revokeObjectURL(url);
          resolve({ ok: false, error: "timeout" });
        }, 2500);
        w.onmessage = (e) => {
          clearTimeout(timer);
          URL.revokeObjectURL(url);
          try {
            w.terminate();
          } catch (err) {
            /* ignore */
          }
          resolve({ ok: true, ...e.data });
        };
        w.onerror = (e) => {
          clearTimeout(timer);
          resolve({ ok: false, error: String(e.message || e) });
        };
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });

  const nativeCheck = {};
  const nativeTargets = {
    "navigator.permissions.query": () => navigator.permissions && navigator.permissions.query,
    "navigator.webdriver.getter": () => {
      const d = Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver");
      return d ? d.get : null;
    },
    "navigator.languages.getter": () => {
      const d = Object.getOwnPropertyDescriptor(Navigator.prototype, "languages");
      return d ? d.get : null;
    },
    "WebGLRenderingContext.getParameter": () =>
      window.WebGLRenderingContext && WebGLRenderingContext.prototype.getParameter,
    "HTMLCanvasElement.toDataURL": () => HTMLCanvasElement.prototype.toDataURL,
    "Element.getBoundingClientRect": () => Element.prototype.getBoundingClientRect,
    "HTMLIFrameElement.contentWindow.getter": () => {
      const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
      return d ? d.get : null;
    },
    "Function.prototype.toString": () => Function.prototype.toString,
    "navigator.getBattery": () => navigator.getBattery,
    "AudioContext.createOscillator": () =>
      window.AudioContext ? AudioContext.prototype.createOscillator : null,
    "RTCPeerConnection": () => window.RTCPeerConnection,
    "Screen.width.getter": () => {
      const d = Object.getOwnPropertyDescriptor(Screen.prototype, "width");
      return d ? d.get : null;
    },
  };
  for (const key in nativeTargets) {
    let fn = null;
    try {
      fn = nativeTargets[key]();
    } catch (e) {
      nativeCheck[key] = "error:" + String(e).slice(0, 60);
      continue;
    }
    if (typeof fn !== "function") {
      nativeCheck[key] = "missing";
      continue;
    }
    let src = "";
    try {
      src = Function.prototype.toString.call(fn);
    } catch (e) {
      src = "throws";
    }
    nativeCheck[key] = /\{\s*\[native code\]\s*\}?/.test(src) ? "native" : "patched:" + src.slice(0, 90);
  }

  const SUSPICIOUS =
    /^(cdc_|__cdc_|\$cdc_|_cdc_)|(__selenium|__webdriver|__playwright|__puppeteer|__pw_|_phantom|callSelenium|domAutomation|__nightmare|__driver_evaluate|__webdriver_evaluate|__fxdriver|__selenium_evaluate|__lastWatir|__playwright_evaluation_script__)/i;
  const artifacts = [];
  safe("artifacts.own", () => {
    for (const k of Object.getOwnPropertyNames(window)) {
      if (SUSPICIOUS.test(k)) artifacts.push(k);
    }
  });
  safe("artifacts.forin", () => {
    for (const k in window) {
      if (SUSPICIOUS.test(k) && artifacts.indexOf(k) === -1) artifacts.push(k);
    }
  });

  out.automation = {
    webdriver: out.navigator.webdriver,
    webdriverExposed: out.navigator.webdriverInNavigator,
    windowArtifacts: artifacts,
    nativeCheck,
    cdpConsole: await cdpConsoleProbe(),
    stack: stackProbe(),
    iframe: iframeRealm(),
    worker: await workerRealm(),
    hasErrorPrepareStackTrace: safe("prepareStackTrace", () => typeof Error.prepareStackTrace),
  };

  /* --------------------------------------------------------------- storage */
  out.storage = await safeAsync(
    "storage",
    async () => {
      const r = { supported: !!(navigator.storage && navigator.storage.estimate) };
      if (r.supported) {
        const e = await navigator.storage.estimate();
        r.quota = e.quota;
        r.usage = e.usage;
      }
      try {
        r.localStorage = !!window.localStorage;
        r.sessionStorage = !!window.sessionStorage;
        r.indexedDB = !!window.indexedDB;
        r.cookieLength = document.cookie.length;
        window.localStorage.setItem("__reddic_probe__", "1");
        window.localStorage.removeItem("__reddic_probe__");
        r.localStorageWritable = true;
      } catch (e) {
        r.localStorageWritable = false;
        r.error = String(e).slice(0, 120);
      }
      return r;
    },
    {}
  );

  /* ------------------------------------------------------------ connection */
  out.connection = safe(
    "connection",
    () => {
      const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!c) return { supported: false };
      return {
        supported: true,
        effectiveType: c.effectiveType,
        rtt: c.rtt,
        downlink: c.downlink,
        downlinkMax: c.downlinkMax,
        saveData: c.saveData,
        type: c.type,
      };
    },
    { supported: false }
  );

  /* ---------------------------------------------------------------- speech */
  out.speech = await safeAsync(
    "speech",
    () =>
      new Promise((resolve) => {
        if (!window.speechSynthesis) return resolve({ supported: false, voices: [] });
        const read = () => {
          const v = speechSynthesis.getVoices() || [];
          return v.map((x) => x.name + "|" + x.lang);
        };
        let voices = read();
        if (voices.length) return resolve({ supported: true, count: voices.length, voices: voices.slice(0, 12) });
        const t = setTimeout(
          () => resolve({ supported: true, count: (voices = read()).length, voices: voices.slice(0, 12) }),
          800
        );
        speechSynthesis.onvoiceschanged = () => {
          clearTimeout(t);
          voices = read();
          resolve({ supported: true, count: voices.length, voices: voices.slice(0, 12) });
        };
      }),
    { supported: false }
  );

  /* --------------------------------------------------------------- battery */
  out.battery = await safeAsync(
    "battery",
    () =>
      new Promise((resolve) => {
        if (!navigator.getBattery) return resolve({ supported: false });
        const t = setTimeout(() => resolve({ supported: false, reason: "timeout" }), 1200);
        navigator
          .getBattery()
          .then((b) => {
            clearTimeout(t);
            resolve({ supported: true, charging: b.charging, level: b.level, chargingTime: b.chargingTime });
          })
          .catch(() => {
            clearTimeout(t);
            resolve({ supported: false, reason: "rejected" });
          });
      }),
    { supported: false }
  );

  /* ---------------------------------------------------------------- timing */
  out.timing = safe(
    "timing",
    () => {
      const a = performance.now();
      let b = a;
      let steps = 0;
      while (a === b && steps < 200000) {
        b = performance.now();
        steps++;
      }
      return {
        timeOrigin: performance.timeOrigin,
        coarseResolution: steps > 2000,
        resolutionSteps: steps,
        hasPerformanceMemory: !!(performance && performance.memory),
        jsHeapSizeLimit: performance && performance.memory ? performance.memory.jsHeapSizeLimit : null,
        elapsed: performance.now() - t0,
      };
    },
    {}
  );

  return out;
}
