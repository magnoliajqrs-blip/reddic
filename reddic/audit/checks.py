"""Rule engine for the detection audit.

Design: probe.js *only collects*. Every judgement is here, in Python, so that
rules can be unit-tested against saved JSON fixtures with no browser running.

A finding has:
    id        stable slug (use it in CI baselines)
    category  automation | fingerprint | consistency | headless | network
    severity  critical | high | medium | low
    title     one line, human
    detail    what was observed
    evidence  the raw values that triggered it
    fix       what to change in the profile/launch config

Scores are computed per category (100 - penalties), then weighted:
    automation 35% | consistency 25% | fingerprint 20% | headless 10% | network 10%

A single `critical` means the run is detectable regardless of the total, because
that is what production anti-bot systems do: hard signals short-circuit scoring.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

SEVERITY_PENALTY = {"critical": 34, "high": 14, "medium": 6, "low": 2}
CATEGORY_WEIGHT = {
    "automation": 0.35,
    "consistency": 0.25,
    "fingerprint": 0.20,
    "headless": 0.10,
    "network": 0.10,
}
CATEGORIES = tuple(CATEGORY_WEIGHT)

# Linux-only font families. Seeing these while the UA claims Windows/macOS is a
# hard tell -- one of the most reliable container/headless detectors in practice.
LINUX_ONLY_FONTS = {
    "DejaVu Sans", "Liberation Sans", "Ubuntu", "Cantarell", "Fira Sans",
    "Noto Sans", "DejaVu Serif", "DejaVu Sans Mono", "Liberation Serif",
}
MAC_ONLY_FONTS = {"Menlo", "Monaco", "Optima", "San Francisco", "Helvetica Neue"}
WINDOWS_ONLY_FONTS = {
    "Segoe UI", "Calibri", "Cambria", "Candara", "Consolas", "Constantia",
    "Corbel", "Ebrima", "Gabriola", "Malgun Gothic", "Microsoft YaHei",
    "MS Gothic", "Palatino Linotype", "Segoe Print", "Segoe Script",
    "Segoe UI Emoji", "Segoe UI Symbol", "Sylfaen", "Tahoma", "Wingdings",
}
SOFTWARE_RENDERERS = (
    "swiftshader", "llvmpipe", "software", "mesa offscreen", "basic render",
    "microsoft basic render driver", "microsoft basic display",
)
KNOWN_CHROMIUM = re.compile(r"(Chrome|Chromium|HeadlessChrome)/(\d+)", re.I)
KNOWN_FIREFOX = re.compile(r"(Firefox)/(\d+)", re.I)
KNOWN_EDGE = re.compile(r"(Edg|EdgA|EdgiOS)/(\d+)", re.I)
KNOWN_SAFARI = re.compile(r"Version/(\d+)[.\d]* Safari/", re.I)
TOOL_STACK_MARKERS = (
    "playwright", "puppeteer", "__pw", "pw_", "webdriver", "selenium",
    "cypress", "cdp_inject", "evaluate_script", "nd_eval",
)
MODERN_CHROME_FLOOR = 120  # anything older reads as "abandoned automation"


@dataclass
class Finding:
    id: str
    category: str
    severity: str
    title: str
    detail: str
    fix: str = ""
    evidence: Any = None

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class Report:
    score: int = 0
    grade: str = "F"
    verdict: str = "UNKNOWN"
    browser: Dict[str, Any] = field(default_factory=dict)
    category_scores: Dict[str, int] = field(default_factory=dict)
    findings: List[Finding] = field(default_factory=list)
    probe_errors: List[str] = field(default_factory=list)
    meta: Dict[str, Any] = field(default_factory=dict)
    network: Dict[str, Any] = field(default_factory=dict)

    @property
    def critical(self) -> List[Finding]:
        return [f for f in self.findings if f.severity == "critical"]

    @property
    def failed(self) -> bool:
        return bool(self.critical)

    def as_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["findings"] = [f.as_dict() for f in self.findings]
        d["critical"] = len(self.critical)
        d["failed"] = self.failed
        return d


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def get(signals: Dict[str, Any], path: str, default: Any = None) -> Any:
    cur: Any = signals
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return default
    return default if cur is None else cur


def browser_family(ua: str) -> str:
    if not ua:
        return "unknown"
    if KNOWN_EDGE.search(ua):
        return "edge"
    if KNOWN_CHROMIUM.search(ua):
        return "chromium"
    if KNOWN_FIREFOX.search(ua):
        return "firefox"
    if KNOWN_SAFARI.search(ua):
        return "safari"
    return "unknown"


def browser_version(ua: str) -> Optional[int]:
    for rx in (KNOWN_EDGE, KNOWN_FIREFOX, KNOWN_CHROMIUM):
        m = rx.search(ua or "")
        if m:
            try:
                return int(m.group(2))
            except (TypeError, ValueError):
                return None
    return None


def ua_platform(ua: str) -> str:
    ua = ua or ""
    if "Windows" in ua:
        return "windows"
    if "Android" in ua:
        return "android"
    if "iPhone" in ua or "iPad" in ua:
        return "ios"
    if "Macintosh" in ua or "Mac OS X" in ua:
        return "macos"
    if "CrOS" in ua:
        return "chromeos"
    if "Linux" in ua:
        return "linux"
    return "unknown"


def nav_platform_family(platform: str) -> str:
    p = (platform or "").lower()
    if p.startswith("win"):
        return "windows"
    if p.startswith("mac"):
        return "macos"
    if p.startswith("linux"):
        return "linux"
    if "android" in p:
        return "android"
    if "iphone" in p or "ipad" in p:
        return "ios"
    return "unknown"


# --------------------------------------------------------------------------- #
# checks
# --------------------------------------------------------------------------- #
CHECKS: List[Callable[[Dict[str, Any]], Optional[Finding]]] = []


def check(fn: Callable[[Dict[str, Any]], Optional[Finding]]):
    CHECKS.append(fn)
    return fn


# ---- automation layer ----------------------------------------------------- #
@check
def chk_webdriver_flag(s: Dict[str, Any]) -> Optional[Finding]:
    if get(s, "navigator.webdriver") is True:
        return Finding(
            "nav.webdriver-true", "automation", "critical",
            "navigator.webdriver reports true",
            "The single oldest automation tell. Every serious bot system checks it first.",
            "Use a modern engine (nodriver/patchright/camoufox) that never sets this flag; "
            "do not patch it with JS, patched getters are detectable via toString.",
            True,
        )
    return None


@check
def chk_window_artifacts(s: Dict[str, Any]) -> Optional[Finding]:
    arts = get(s, "automation.windowArtifacts", []) or []
    if arts:
        return Finding(
            "automation.window-artifacts", "automation", "critical",
            "Automation artifacts exposed on window",
            f"Found {', '.join(arts[:6])} -- classic ChromeDriver/Selenium/Playwright globals.",
            "Switch to an engine without these globals. Any JS re-patch leaves a "
            "non-native function body that is itself flagged.",
            arts,
        )
    return None


@check
def chk_cdp_console(s: Dict[str, Any]) -> Optional[Finding]:
    if get(s, "automation.cdpConsole.leaked") is True:
        return Finding(
            "automation.cdp-runtime-enabled", "automation", "critical",
            "CDP Runtime domain is active on the page",
            "A getter fired only because the debugger serialised a logged object. "
            "This is the leak Patchright/nodriver patch out at startup.",
            "Disable Runtime.enable / Target.setAutoAttach (patchright with "
            "channel=chrome, or nodriver). This is the #1 remaining CDP leak in 2026.",
            {"leaked": True},
        )
    return None


@check
def chk_automation_stack(s: Dict[str, Any]) -> Optional[Finding]:
    stack = str(get(s, "automation.stack", "")).lower()
    hits = [m for m in TOOL_STACK_MARKERS if m in stack]
    if hits:
        return Finding(
            "automation.stack-marker", "automation", "critical",
            "Automation framework name appears in an Error stack",
            f"Stack contained: {', '.join(hits)}. Injected scripts show up as "
            f"anonymous stack frames from a non-page origin.",
            "Avoid injected evaluation in page context. Prefer binary-level patching; "
            "evaluate only inside isolated worlds when unavoidable.",
            stack[:300],
        )
    return None


@check
def chk_native_patched(s: Dict[str, Any]) -> Optional[Finding]:
    native = get(s, "automation.nativeCheck", {}) or {}
    bad = {k: v for k, v in native.items() if isinstance(v, str) and v.startswith("patched:")}
    if not bad:
        return None
    sev = "critical" if len(bad) > 2 else "high"
    return Finding(
        "automation.patched-native-fn", "automation", sev,
        "Native function bodies have been replaced",
        "These resolved to a JS body instead of [native code] -- the fingerprinting "
        "layer sees a browser that lies about its own builtins.",
        "Remove JS-level stealth patches. If the engine truly needs a change, make it "
        "at the C++/binary level so the function stays native.",
        bad,
    )


@check
def chk_iframe_realm(s: Dict[str, Any]) -> Optional[Finding]:
    ifr = get(s, "automation.iframe", {}) or {}
    if not ifr.get("ok"):
        return None
    top = s.get("navigator", {}) or {}
    diffs = {}
    if ifr.get("userAgent") != top.get("userAgent"):
        diffs["userAgent"] = [top.get("userAgent"), ifr.get("userAgent")]
    if ifr.get("platform") != top.get("platform"):
        diffs["platform"] = [top.get("platform"), ifr.get("platform")]
    if ifr.get("webdriver") != top.get("webdriver"):
        diffs["webdriver"] = [top.get("webdriver"), ifr.get("webdriver")]
    if (ifr.get("plugins") or 0) != len(top.get("plugins") or []):
        diffs["plugins"] = [len(top.get("plugins") or []), ifr.get("plugins")]
    if set(ifr.get("languages") or []) != set(top.get("languages") or []):
        diffs["languages"] = [top.get("languages"), ifr.get("languages")]
    if diffs:
        return Finding(
            "automation.iframe-realm-diff", "automation", "critical",
            "Fingerprint differs between main frame and subframe",
            "A stealth patch was applied to the top-level realm only. Any site that "
            "creates a hidden iframe (most bot systems do) sees the real values.",
            "Patch at the engine level, not per-realm. If patching JS, patch every "
            "realm including workers.",
            diffs,
        )
    return None


@check
def chk_worker_realm(s: Dict[str, Any]) -> Optional[Finding]:
    w = get(s, "automation.worker", {}) or {}
    if not w.get("ok"):
        return None
    top = s.get("navigator", {}) or {}
    diffs = {}
    for a, b in (("userAgent", "userAgent"), ("platform", "platform"), ("hardwareConcurrency", "hardwareConcurrency")):
        if w.get(a) != top.get(b):
            diffs[a] = [top.get(b), w.get(a)]
    if (w.get("deviceMemory") or None) != (top.get("deviceMemory") or None):
        diffs["deviceMemory"] = [top.get("deviceMemory"), w.get("deviceMemory")]
    if diffs:
        return Finding(
            "automation.worker-realm-diff", "automation", "high",
            "Fingerprint differs inside a Web Worker",
            "Worker realm was not patched. Workers are the cheapest cross-check a "
            "detector can run and the most commonly forgotten realm.",
            "Apply the same overrides inside workers, or patch natively.",
            diffs,
        )
    return None


# ---- consistency ---------------------------------------------------------- #
@check
def chk_ua_vs_uach(s: Dict[str, Any]) -> Optional[Finding]:
    ua = get(s, "navigator.userAgent", "") or ""
    uad = s.get("uaData") or {}
    if not uad:
        if browser_family(ua) == "chromium":
            return Finding(
                "consistency.no-uach", "consistency", "high",
                "Chromium UA but no userAgentData",
                "Every Chromium build since 90 exposes navigator.userAgentData. "
                "Its absence means the identity was faked at the string level.",
                "Use a real Chromium binary instead of rewriting the UA string.",
                ua[:120],
            )
        return None
    high = uad.get("high") or {}
    brands = [b.get("brand", "") for b in (uad.get("brands") or []) if isinstance(b, dict)]
    # Chromium brands always contain a not-A-Brand entry; absence = hand-built list.
    if brands and not any("Not" in b for b in brands):
        return Finding(
            "consistency.uach-brands", "consistency", "high",
            "UA-CH brand list has no GREASE entry",
            f"Brands reported: {brands}. Real Chromium inserts a randomised "
            f"'Not(A:Brand...' GREASE entry into every brand list.",
            "Do not synthesise UA-CH. Let the real binary report it.",
            brands,
        )
    full = high.get("fullVersionList") or []
    ua_major = browser_version(ua)
    if ua_major is not None and full:
        try:
            rep = int(str(next((b.get("version") for b in full if b.get("brand") == "Chromium"), "0")).split(".")[0])
            if rep and abs(rep - ua_major) > 0:
                return Finding(
                    "consistency.version-mismatch", "consistency", "high",
                    "UA string version != UA-CH version",
                    f"UA says {ua_major}, UA-CH reports {rep}.",
                    "Keep the UA override derived from the real binary version.",
                    {"ua": ua_major, "uach": rep},
                )
        except (StopIteration, ValueError, TypeError):
            pass
    plat = (uad.get("platform") or "").lower()
    fam = nav_platform_family(get(s, "navigator.platform", ""))
    if plat and fam not in ("unknown",) and plat not in fam and not (plat == "macos" and fam == "macos"):
        return Finding(
            "consistency.uach-platform", "consistency", "high",
            "UA-CH platform disagrees with navigator.platform",
            f"UA-CH platform={plat!r}, navigator.platform maps to {fam!r}.",
            "Derive every platform signal from one source of truth.",
            {"uach": plat, "platform": fam},
        )
    return None


@check
def chk_ua_platform_consistency(s: Dict[str, Any]) -> Optional[Finding]:
    ua_fam = ua_platform(get(s, "navigator.userAgent", ""))
    nav_fam = nav_platform_family(get(s, "navigator.platform", ""))
    if "unknown" in (ua_fam, nav_fam):
        return None
    if ua_fam != nav_fam:
        return Finding(
            "consistency.ua-platform-mismatch", "consistency", "critical",
            "User-Agent OS and navigator.platform disagree",
            f"UA claims {ua_fam} but navigator.platform reads {nav_fam}.",
            "Never mix a spoofed UA with a real platform. Pick one persona and apply "
            "it everywhere, ideally by running the matching OS.",
            {"ua": ua_fam, "platform": nav_fam},
        )
    return None


@check
def chk_timezone_ip(s: Dict[str, Any]) -> Optional[Finding]:
    tz = get(s, "intl.timeZone")
    net = s.get("network") or {}
    country = net.get("country")
    if not tz or not country:
        return None
    # Local table kept in network.py; duplicate the common cases to avoid a cycle.
    expect = {
        "Asia/Dhaka": "BD", "Asia/Kolkata": "IN", "Asia/Karachi": "PK",
        "Europe/London": "GB", "Europe/Berlin": "DE", "Europe/Paris": "FR",
        "America/New_York": "US", "America/Chicago": "US",
        "America/Denver": "US", "America/Los_Angeles": "US",
        "Asia/Singapore": "SG", "Asia/Tokyo": "JP", "Australia/Sydney": "AU",
    }.get(tz)
    if expect and expect != str(country).upper():
        return Finding(
            "consistency.tz-ip-mismatch", "consistency", "critical",
            "Browser timezone does not match exit IP",
            f"Timezone {tz} (expects {expect}) but IP geolocates to {country}.",
            "Derive timezone, locale and geolocation from the proxy's IP. If you cannot, "
            "drop that proxy -- no amount of engine patching fixes a geo mismatch.",
            {"tz": tz, "ip_country": country},
        )
    return None


@check
def chk_utc_timezone(s: Dict[str, Any]) -> Optional[Finding]:
    if get(s, "intl.timeZone") == "UTC":
        return Finding(
            "consistency.tz-utc", "consistency", "high",
            "Browser timezone is UTC",
            "Almost no consumer desktop runs in UTC. Docker and headless defaults do. "
            "This alone is used as a strong prior by several vendors.",
            "Set TZ from the proxy geo before launch; verify with Intl.DateTimeFormat.",
            "UTC",
        )
    return None


@check
def chk_languages(s: Dict[str, Any]) -> Optional[Finding]:
    langs = get(s, "navigator.languages") or []
    lang = get(s, "navigator.language")
    if not langs:
        return Finding(
            "consistency.no-languages", "consistency", "high",
            "navigator.languages is empty",
            "Real browsers always report at least one language.",
            "Set Accept-Language and the browser language together.",
            langs,
        )
    if lang and langs and lang != langs[0]:
        return Finding(
            "consistency.language-first", "consistency", "medium",
            "navigator.language != navigator.languages[0]",
            f"language={lang!r}, languages[0]={langs[0]!r}.",
            "Chrome derives language from languages[0]; keep them in sync.",
            {"language": lang, "languages": langs[:4]},
        )
    return None


@check
def chk_locale_tz(s: Dict[str, Any]) -> Optional[Finding]:
    tz = get(s, "intl.timeZone") or ""
    loc = get(s, "intl.locale") or ""
    if not tz or not loc:
        return None
    region = loc.split("-")[-1].upper() if "-" in loc else ""
    tz_region = tz.split("/")[0]
    # A very loose sanity rule: a US locale with an Asian zone is plausible for
    # expats, so only flag the really implausible pair.
    implausible = (
        (region == "US" and tz_region in ("Asia", "Africa"))
        or (region in ("BD", "IN", "PK") and tz_region in ("America", "Europe"))
    )
    if implausible:
        return Finding(
            "consistency.locale-tz-weak", "consistency", "low",
            "Locale and timezone look unrelated",
            f"locale={loc}, timezone={tz}. Low-confidence signal; fix if cheap.",
            "Set both from the proxy geo.",
            {"locale": loc, "timezone": tz},
        )
    return None


@check
def chk_mobile_touch(s: Dict[str, Any]) -> Optional[Finding]:
    uad = s.get("uaData") or {}
    mobile = uad.get("mobile")
    touch = get(s, "navigator.maxTouchPoints") or 0
    if mobile is True and touch == 0:
        return Finding(
            "consistency.mobile-no-touch", "consistency", "high",
            "UA-CH says mobile but maxTouchPoints is 0",
            "Mobile personas must expose touch points and a mobile viewport.",
            "Use device emulation from the engine rather than a UA string edit.",
            {"mobile": mobile, "maxTouchPoints": touch},
        )
    if mobile is False and touch > 10:
        return Finding(
            "consistency.desktop-many-touch", "consistency", "low",
            "Desktop persona claims a high touch point count",
            "maxTouchPoints > 10 on a desktop UA is rare.",
            "Set maxTouchPoints to 0 for desktop profiles.",
            touch,
        )
    return None


@check
def chk_screen_vs_window(s: Dict[str, Any]) -> Optional[Finding]:
    iw = get(s, "window.innerWidth") or 0
    ih = get(s, "window.innerHeight") or 0
    ow = get(s, "window.outerWidth") or 0
    oh = get(s, "window.outerHeight") or 0
    if ow and oh and iw == ow and ih == oh and browser_family(get(s, "navigator.userAgent", "")) == "chromium":
        return Finding(
            "consistency.inner-equals-outer", "consistency", "high",
            "innerWidth/Height equal outerWidth/Height",
            "On every real desktop OS the browser frame steals vertical space "
            "(~80-140px). Exact equality is the signature of headless or an "
            "offscreen window manager.",
            "Run headful under a virtual display, or set an outer window size "
            "larger than the viewport.",
            {"inner": [iw, ih], "outer": [ow, oh]},
        )
    return None


# ---- fingerprint ---------------------------------------------------------- #
@check
def chk_canvas(s: Dict[str, Any]) -> Optional[Finding]:
    c = s.get("canvas") or {}
    if not c.get("ok"):
        return Finding(
            "fingerprint.canvas-missing", "fingerprint", "medium",
            "Canvas rendering is unavailable",
            "No 2D context could be created; real browsers always can.",
            "Check that --disable-gpu is not disabling the software rasteriser path.",
            c,
        )
    if c.get("stableSameDraw") is False:
        return Finding(
            "fingerprint.canvas-unstable", "fingerprint", "high",
            "Canvas hash changes between two identical draws",
            "Canvas noise randomisation is itself a fingerprint: real GPUs are "
            "deterministic for the same draw call.",
            "Do not add per-call canvas noise. Spoof once per profile by patching at "
            "the C++ level, and keep it stable across sessions.",
            c.get("hash"),
        )
    if not c.get("differsOnDifferentDraw"):
        return Finding(
            "fingerprint.canvas-constant", "fingerprint", "medium",
            "Canvas output does not change when the drawing changes",
            "The renderer is returning a fixed buffer -- a stub implementation.",
            "Use software GL (SwiftShader) or a virtual GPU that actually rasterises.",
            c.get("hash"),
        )
    return None


@check
def chk_webgl_present(s: Dict[str, Any]) -> Optional[Finding]:
    w = s.get("webgl") or {}
    if not w.get("supported"):
        return Finding(
            "fingerprint.webgl-missing", "fingerprint", "high",
            "WebGL is unavailable",
            "Every modern desktop browser exposes WebGL. Its absence is a strong "
            "headless/VM prior.",
            "Enable software WebGL: --use-gl=angle --use-angle=swiftshader (headless) "
            "or use a real GPU / virtual display.",
            w,
        )
    return None


@check
def chk_webgl_software(s: Dict[str, Any]) -> Optional[Finding]:
    w = s.get("webgl") or {}
    renderer = " ".join(
        str(w.get(k) or "") for k in ("renderer", "unmaskedRenderer", "vendor", "unmaskedVendor")
    ).lower()
    if any(m in renderer for m in SOFTWARE_RENDERERS):
        return Finding(
            "fingerprint.webgl-software", "fingerprint", "critical",
            "WebGL reports a software renderer",
            f"Renderer string: {w.get('unmaskedRenderer') or w.get('renderer')!r}. "
            f"SwiftShader/llvmpipe is the canonical headless signature and is used "
            f"as a hard block by several vendors.",
            "Provide a plausible GPU string AND make rendering cost look like that GPU. "
            "A spoofed string over a software rasteriser fails timing probes. "
            "Best: real GPU pass-through, or an engine that virtualises shader timing.",
            {"renderer": w.get("unmaskedRenderer") or w.get("renderer"), "vendor": w.get("unmaskedVendor")},
        )
    return None


@check
def chk_webgl_debug_ext(s: Dict[str, Any]) -> Optional[Finding]:
    w = s.get("webgl") or {}
    if w.get("supported") and not w.get("debugInfoAvailable") and w.get("unmaskedRenderer") is None:
        return Finding(
            "fingerprint.webgl-no-debug-ext", "fingerprint", "low",
            "WEBGL_debug_renderer_info not exposed",
            "Firefox hides it behind privacy.resistFingerprinting; Chromium exposes it.",
            "If the persona is Chromium, expose the extension with a coherent renderer.",
            w.get("extensions"),
        )
    return None


@check
def chk_webgl_ext_count(s: Dict[str, Any]) -> Optional[Finding]:
    w = s.get("webgl") or {}
    n = w.get("extensionCount")
    if w.get("supported") and n is not None and n < 5:
        return Finding(
            "fingerprint.webgl-few-extensions", "fingerprint", "high",
            "WebGL exposes almost no extensions",
            f"{n} extensions supported; a real desktop GPU exposes 20-40.",
            "Use a virtualised GPU profile with a realistic extension list for the GPU "
            "being claimed.",
            n,
        )
    return None


@check
def chk_audio(s: Dict[str, Any]) -> Optional[Finding]:
    a = s.get("audio") or {}
    if not a.get("ok"):
        return Finding(
            "fingerprint.audio-missing", "fingerprint", "medium",
            "OfflineAudioContext rendering failed",
            "AudioContext is a standard, stable fingerprinting surface; failure is "
            "atypical for a desktop browser.",
            "Ensure the audio stack exists in the image (even a null device) so "
            "OfflineAudioContext can render.",
            a,
        )
    if a.get("hash") in (None, "0.000000", "0"):
        return Finding(
            "fingerprint.audio-zero", "fingerprint", "high",
            "Audio fingerprint is zero",
            "Silent output means the audio stack is missing or stubbed.",
            "Install a real/emulated audio device in the container.",
            a.get("hash"),
        )
    return None


@check
def chk_fonts_count(s: Dict[str, Any]) -> Optional[Finding]:
    f = s.get("fonts") or {}
    if not f.get("supported"):
        return None
    n = f.get("count") or 0
    if n < 8:
        return Finding(
            "fingerprint.few-fonts", "fingerprint", "high",
            "Suspiciously few system fonts",
            f"Only {n} of {f.get('tested')} probed families present. Bare container "
            f"images have this exact font list.",
            "Install the font pack matching the persona OS (e.g. Windows core fonts "
            "for a Windows profile), and remove Linux-only families.",
            f.get("detected"),
        )
    return None


@check
def chk_fonts_os_leak(s: Dict[str, Any]) -> Optional[Finding]:
    f = s.get("fonts") or {}
    ua_fam = ua_platform(get(s, "navigator.userAgent", ""))
    detected = set(f.get("detected") or [])
    if not detected:
        return None
    if ua_fam in ("windows", "macos"):
        leak = sorted(detected & LINUX_ONLY_FONTS)
        if leak:
            return Finding(
                "fingerprint.linux-fonts", "fingerprint", "high",
                f"Linux-only fonts visible on a {ua_fam} persona",
                f"Detected {', '.join(leak[:5])}. This is a direct OS leak that does "
                f"not depend on any scripted detection.",
                "Remove Linux font packages from the image; use the OS matching the "
                "persona or a font set that is plausible for it.",
                leak,
            )
    if ua_fam == "windows":
        leak = sorted(detected & MAC_ONLY_FONTS)
        if leak:
            return Finding(
                "fingerprint.mac-fonts-on-windows", "fingerprint", "low",
                "macOS-only fonts visible on a Windows persona",
                f"Detected {', '.join(leak[:4])}.",
                "Align the font set with the persona.",
                leak,
            )
    if ua_fam == "macos":
        leak = sorted(detected & WINDOWS_ONLY_FONTS)
        if leak:
            return Finding(
                "fingerprint.win-fonts-on-mac", "fingerprint", "low",
                "Windows-only fonts visible on a macOS persona",
                f"Detected {', '.join(leak[:4])}.",
                "Align the font set with the persona.",
                leak,
            )
    return None


@check
def chk_speech(s: Dict[str, Any]) -> Optional[Finding]:
    sp = s.get("speech") or {}
    if sp.get("supported") and sp.get("count") == 0:
        return Finding(
            "fingerprint.no-tts-voices", "fingerprint", "high",
            "speechSynthesis reports zero voices",
            "Headless Chrome without TTS returns an empty voice list, and the list is "
            "a very stable per-OS fingerprint that detectors compare against the UA.",
            "Install speech-dispatcher + a voice set matching the persona OS, or use a "
            "patched build that supplies a coherent list.",
            sp,
        )
    return None


# ---- headless ------------------------------------------------------------- #
@check
def chk_headless_ua(s: Dict[str, Any]) -> Optional[Finding]:
    ua = get(s, "navigator.userAgent", "") or ""
    if "HeadlessChrome" in ua:
        return Finding(
            "headless.ua-marker", "headless", "critical",
            "User-Agent contains 'HeadlessChrome'",
            "Literal self-identification.",
            "Use --headless=new (which omits it) and never hand-build the UA string.",
            ua,
        )
    return None


@check
def chk_headless_plugins(s: Dict[str, Any]) -> Optional[Finding]:
    fam = browser_family(get(s, "navigator.userAgent", ""))
    plugins = get(s, "navigator.plugins") or []
    if fam in ("chromium", "edge", "firefox") and len(plugins) == 0:
        return Finding(
            "headless.no-plugins", "headless", "high",
            "navigator.plugins is empty",
            "Chrome exposes 5 built-in PDF-related plugin entries; Firefox exposes "
            "similarly stable entries. An empty list is a headless default.",
            "Prefer a real build over JS overrides; plugin arrays are enumerated and "
            "compared against navigator.mimeTypes.",
            plugins,
        )
    return None


@check
def chk_chrome_object(s: Dict[str, Any]) -> Optional[Finding]:
    fam = browser_family(get(s, "navigator.userAgent", ""))
    ch = s.get("chrome") or {}
    if fam in ("chromium", "edge") and not ch.get("present"):
        return Finding(
            "headless.no-chrome-object", "headless", "critical",
            "window.chrome is missing on a Chromium UA",
            "Every Chromium engine injects window.chrome into page context. Its "
            "absence is checked everywhere and is trivially reliable.",
            "Use a genuine Chromium build; if the engine strips it, re-enable it "
            "natively instead of defining it in JS.",
            ch,
        )
    if fam in ("chromium", "edge") and ch.get("present") and not ch.get("keys"):
        return Finding(
            "headless.chrome-empty", "headless", "high",
            "window.chrome exists but has no properties",
            "A hand-defined window.chrome is detectable by key enumeration.",
            "Let the engine provide its own object.",
            ch,
        )
    return None


@check
def chk_headless_viewport(s: Dict[str, Any]) -> Optional[Finding]:
    w = s.get("screen") or {}
    size = (w.get("width"), w.get("height"))
    if size in ((800, 600), (1024, 768), (1280, 720)) and get(s, "window.outerWidth") in (800, 1024, 1280):
        return Finding(
            "headless.default-viewport", "headless", "medium",
            "Screen size equals a default headless preset",
            f"{size[0]}x{size[1]} with a matching outer window is the headless default.",
            "Randomise the viewport per profile from a realistic resolution pool.",
            size,
        )
    if w.get("availWidth") == w.get("width") and w.get("availHeight") == w.get("height") and ua_platform(get(s, "navigator.userAgent", "")) == "windows":
        return Finding(
            "headless.no-taskbar", "headless", "medium",
            "availHeight equals height on a Windows persona",
            "Windows always reserves space for the taskbar; equality means no shell "
            "is running the browser.",
            "Run headful under a real desktop session, or keep the geometry consistent.",
            {"height": w.get("height"), "availHeight": w.get("availHeight")},
        )
    return None


@check
def chk_hardware(s: Dict[str, Any]) -> Optional[Finding]:
    hc = get(s, "navigator.hardwareConcurrency")
    dm = get(s, "navigator.deviceMemory")
    if hc in (1, 0):
        return Finding(
            "headless.single-core", "headless", "medium",
            "hardwareConcurrency reports 1",
            "Single-core machines are almost unheard of in home traffic and are the "
            "container default.",
            "Set a realistic core count in the profile (4-16) end to end, including "
            "the engine's scheduling behaviour.",
            hc,
        )
    if dm is None and browser_family(get(s, "navigator.userAgent", "")) == "chromium":
        return Finding(
            "headless.no-device-memory", "headless", "low",
            "navigator.deviceMemory is undefined",
            "Chromium exposes an approximate memory tier; undefined suggests an "
            "unusual build or an incomplete override.",
            "Leave it native if it is already correct; otherwise derive it from the "
            "same profile seed.",
            dm,
        )
    return None


@check
def chk_media_devices(s: Dict[str, Any]) -> Optional[Finding]:
    m = s.get("media") or {}
    if not m.get("supported"):
        return Finding(
            "headless.no-media-devices-api", "headless", "medium",
            "navigator.mediaDevices is unavailable",
            "Present in every modern browser, and only in secure contexts.",
            "Serve over HTTPS or localhost; do not strip the API.",
            m,
        )
    total = m.get("total") or 0
    counts = m.get("counts") or {}
    if total == 0:
        return Finding(
            "headless.zero-media-devices", "headless", "medium",
            "No audio/video devices at all",
            "Headless containers usually expose zero devices; a real laptop almost "
            "always has at least one audio output.",
            "Add a dummy or virtual audio device to the container.",
            m,
        )
    if counts.get("audiooutput", 0) == 0 and counts.get("audioinput", 0) == 0:
        return Finding(
            "headless.no-audio-devices", "headless", "low",
            "No audio devices enumerable",
            f"Device counts: {counts}.",
            "Add a virtual audio device (e.g. a PulseAudio null sink).",
            counts,
        )
    return None


@check
def chk_webrtc(s: Dict[str, Any]) -> Optional[Finding]:
    w = s.get("webrtc") or {}
    if not w.get("supported"):
        return Finding(
            "headless.no-webrtc", "headless", "high",
            "RTCPeerConnection is unavailable",
            "Removing WebRTC is a known anti-fingerprinting hack and is itself a "
            "fingerprint; it also breaks real video sites.",
            "Leave WebRTC enabled and control the exposed IP at the proxy level.",
            w,
        )
    return None


@check
def chk_permissions_notification(s: Dict[str, Any]) -> Optional[Finding]:
    p = s.get("permissions") or {}
    np_ = p.get("notificationPermission")
    state = (p.get("states") or {}).get("notifications")
    if np_ == "denied" and state == "prompt":
        return Finding(
            "headless.permissions-inconsistent", "headless", "high",
            "Notification permission state disagrees with Permissions API",
            f"Notification.permission={np_!r} but permissions.query says {state!r}.",
            "These two must come from the same source; a mismatch means one was "
            "overridden in JS.",
            {"notification": np_, "query": state},
        )
    return None


@check
def chk_battery(s: Dict[str, Any]) -> Optional[Finding]:
    fam = browser_family(get(s, "navigator.userAgent", ""))
    b = s.get("battery") or {}
    if fam in ("chromium", "edge") and not b.get("supported"):
        return Finding(
            "headless.no-battery-api", "headless", "low",
            "Battery Status API is unavailable",
            "Desktop Chrome exposes navigator.getBattery; absence happens in stripped "
            "builds and insecure contexts.",
            "Serve over a secure context and avoid builds with the API removed.",
            b,
        )
    if b.get("supported") and b.get("level") == 1.0 and b.get("charging") is False:
        return Finding(
            "headless.battery-impossible", "headless", "medium",
            "Battery level is 100% while not charging",
            "Physically implausible device state.",
            "Randomise battery state coherently per profile.",
            b,
        )
    return None


# ---- network -------------------------------------------------------------- #
@check
def chk_network_measured(s: Dict[str, Any]) -> Optional[Finding]:
    n = s.get("network") or {}
    if not n:
        return Finding(
            "network.not-measured", "network", "medium",
            "TLS/JA4 layer was not measured",
            "The audit ran without an active network probe, so the most common block "
            "reason (JA4/HTTP2 mismatch) is unverified.",
            "Re-run without --no-network, or point the probe at your own echo server.",
            None,
        )
    if not n.get("ok"):
        return Finding(
            "network.probe-failed", "network", "medium",
            "Network fingerprint probe failed",
            f"{n.get('error')} (endpoint {n.get('endpoint')}).",
            "Allowlist the echo endpoint in the proxy, then re-run.",
            n,
        )
    return None


@check
def chk_ja4_consistency(s: Dict[str, Any]) -> Optional[Finding]:
    n = s.get("network") or {}
    if not n.get("ok"):
        return None
    ua = get(s, "navigator.userAgent", "") or ""
    fam = browser_family(ua)
    seen = (n.get("user_agent_seen") or "")
    if seen and seen.split(" ")[0] and seen != ua:
        return Finding(
            "network.ua-seen-mismatch", "network", "critical",
            "The server sees a different User-Agent than the page reports",
            f"Page: {ua[:90]!r}\nServer: {seen[:90]!r}",
            "An HTTP-layer rewrite (proxy header injection / UA override) is fighting "
            "the browser. Rewrite nothing at the proxy; set identity in the browser.",
            {"page": ua, "server": seen},
        )
    ja4 = (n.get("ja4") or "").lower()
    if fam == "chromium" and ja4.startswith("t13d") and "_h2" not in ja4 and n.get("akamai_fingerprint"):
        if "ff" in ja4.split("_")[0][-2:]:
            return Finding(
                "network.ja4-firefox-order", "network", "high",
                "TLS fingerprint looks like Firefox while UA claims Chromium",
                f"JA4={n.get('ja4')}",
                "Serve Chromium traffic through a Chromium TLS stack. Never let a Go/"
                "Node proxy terminate TLS in front of a browser.",
                {"ja4": n.get("ja4")},
            )
    return None


@check
def chk_http2_settings(s: Dict[str, Any]) -> Optional[Finding]:
    n = s.get("network") or {}
    if not n.get("ok") or not n.get("akamai_fingerprint"):
        return None
    fam = browser_family(get(s, "navigator.userAgent", ""))
    fp = str(n.get("akamai_fingerprint"))
    if fam in ("chromium", "edge") and "2:0" not in fp:
        return Finding(
            "network.h2-settings", "network", "high",
            "HTTP/2 SETTINGS do not look like Chromium",
            f"Akamai fingerprint: {fp[:120]}",
            "The HTTP/2 layer is produced by whatever terminates TLS. Broker the proxy "
            "as a raw TCP/SOCKS5 tunnel so the browser's own stack does the handshake.",
            fp[:200],
        )
    return None


@check
def chk_version_age(s: Dict[str, Any]) -> Optional[Finding]:
    v = browser_version(get(s, "navigator.userAgent", ""))
    if v is None:
        return None
    if v < MODERN_CHROME_FLOOR:
        return Finding(
            "fingerprint.stale-browser", "fingerprint", "medium",
            "Browser major version is far behind current",
            f"Reported major version {v}; current stable is well above {MODERN_CHROME_FLOOR}. "
            f"Stale versions are heavily represented in bot traffic and are blocked "
            f"on reputation, not on signals.",
            "Track stable channel. This is the cheapest win in the whole stack.",
            v,
        )
    return None


# --------------------------------------------------------------------------- #
# scoring
# --------------------------------------------------------------------------- #
def _grade(score: int) -> str:
    for floor, g in ((95, "A+"), (90, "A"), (80, "B"), (70, "C"), (55, "D")):
        if score >= floor:
            return g
    return "F"


def evaluate(signals: Dict[str, Any]) -> Report:
    ua = get(signals, "navigator.userAgent", "") or ""
    rep = Report(
        browser={
            "user_agent": ua,
            "family": browser_family(ua),
            "version": browser_version(ua),
            "platform": ua_platform(ua),
            "ua_ch": bool(signals.get("uaData")),
            "timezone": get(signals, "intl.timeZone"),
            "locale": get(signals, "intl.locale"),
            "screen": [get(signals, "screen.width"), get(signals, "screen.height")],
            "webgl_renderer": get(signals, "webgl.unmaskedRenderer")
            or get(signals, "webgl.renderer"),
            "ja4": (signals.get("network") or {}).get("ja4"),
            "http2": (signals.get("network") or {}).get("akamai_fingerprint_hash"),
        },
        probe_errors=list(signals.get("errors") or []),
        meta=signals.get("meta") or {},
        network=signals.get("network") or {},
    )

    for fn in CHECKS:
        try:
            f = fn(signals)
        except Exception as exc:  # a broken rule must never kill the audit
            rep.probe_errors.append(f"rule {fn.__name__} raised: {exc}")
            continue
        if f is not None:
            rep.findings.append(f)

    # Deduplicate (same id can be produced by different guards)
    seen = set()
    uniq: List[Finding] = []
    for f in rep.findings:
        if f.id in seen:
            continue
        seen.add(f.id)
        uniq.append(f)
    rep.findings = sorted(
        uniq, key=lambda f: (["critical", "high", "medium", "low"].index(f.severity), f.category)
    )

    for cat in CATEGORIES:
        penalty = sum(
            SEVERITY_PENALTY[f.severity] for f in rep.findings if f.category == cat
        )
        rep.category_scores[cat] = max(0, 100 - penalty)

    rep.score = int(round(sum(rep.category_scores[c] * CATEGORY_WEIGHT[c] for c in CATEGORIES)))
    rep.grade = _grade(rep.score)

    if rep.critical:
        rep.verdict = "DETECTABLE"
    elif any(f.severity == "high" for f in rep.findings):
        rep.verdict = "FRAGILE"
    elif rep.findings:
        rep.verdict = "USABLE"
    else:
        rep.verdict = "CLEAN"
    return rep


def summarise(rep: Report, top: int = 6) -> str:
    lines = [
        f"score   {rep.score}/100  grade {rep.grade}  verdict {rep.verdict}",
        f"browser {rep.browser.get('family')} {rep.browser.get('version')} "
        f"on {rep.browser.get('platform')}",
        f"tz {rep.browser.get('timezone')}  locale {rep.browser.get('locale')}  "
        f"screen {rep.browser.get('screen')}",
        f"ja4 {rep.browser.get('ja4')}",
        "",
        "categories: " + "  ".join(f"{c}={v}" for c, v in rep.category_scores.items()),
        "",
    ]
    if not rep.findings:
        lines.append("no findings")
    for f in rep.findings[:top]:
        lines.append(f"[{f.severity.upper():8}] {f.category:12} {f.title}")
        lines.append(f"           {f.detail}")
        if f.fix:
            lines.append(f"           fix: {f.fix}")
    if len(rep.findings) > top:
        lines.append(f"... {len(rep.findings) - top} more findings")
    if rep.probe_errors:
        lines.append("")
        lines.append(f"probe errors: {len(rep.probe_errors)} (see JSON)")
    return "\n".join(lines)


def exit_code(rep: Report) -> int:
    """0 = pass, 1 = critical present, 2 = fragile (only with strict mode)."""
    return 1 if rep.failed else 0
