import json
import pathlib

import pytest

from reddic.audit.checks import CATEGORIES, CHECKS, evaluate, summarise

FIX = pathlib.Path(__file__).parent / "fixtures"


def load(name):
    with open(FIX / name, "r", encoding="utf-8") as fh:
        return json.load(fh)


def ids(rep):
    return {f.id for f in rep.findings}


# --------------------------------------------------------------------------- #
# the two anchor cases
# --------------------------------------------------------------------------- #
def test_vanilla_playwright_is_detectable():
    rep = evaluate(load("vanilla_playwright.json"))
    assert rep.verdict == "DETECTABLE"
    assert rep.failed is True
    assert rep.score < 40
    found = ids(rep)
    # the signals that actually get you blocked, not cosmetic ones
    assert "nav.webdriver-true" in found
    assert "automation.cdp-runtime-enabled" in found
    assert "headless.ua-marker" in found
    assert "headless.no-chrome-object" in found
    assert "fingerprint.webgl-software" in found
    assert "consistency.tz-utc" in found


def test_hardened_chromium_is_clean():
    rep = evaluate(load("hardened_chromium.json"))
    assert rep.verdict == "CLEAN", summarise(rep, top=10)
    assert rep.score == 100
    assert rep.findings == []


# --------------------------------------------------------------------------- #
# rule-engine invariants
# --------------------------------------------------------------------------- #
def test_empty_signals_never_raises():
    rep = evaluate({})
    assert rep.score >= 0
    assert rep.probe_errors == []  # rules must not throw, only report


def test_score_bounds_and_categories_present():
    for name in ("vanilla_playwright.json", "hardened_chromium.json"):
        rep = evaluate(load(name))
        assert 0 <= rep.score <= 100
        assert set(rep.category_scores) == set(CATEGORIES)


def test_all_rules_return_finding_or_none():
    fixture = load("vanilla_playwright.json")
    for fn in CHECKS:
        out = fn(fixture)
        assert out is None or out.id


def test_findings_sorted_by_severity():
    rep = evaluate(load("vanilla_playwright.json"))
    order = ["critical", "high", "medium", "low"]
    ranks = [order.index(f.severity) for f in rep.findings]
    assert ranks == sorted(ranks)


def test_summarise_renders():
    rep = evaluate(load("vanilla_playwright.json"))
    text = summarise(rep)
    assert "DETECTABLE" in text
    assert "categories" in text


# --------------------------------------------------------------------------- #
# individual signals that are easy to regress
# --------------------------------------------------------------------------- #
def test_linux_fonts_on_windows_persona_is_high():
    s = load("hardened_chromium.json")
    s["fonts"]["detected"] = ["DejaVu Sans", "Segoe UI", "Arial"]
    rep = evaluate(s)
    f = [x for x in rep.findings if x.id == "fingerprint.linux-fonts"]
    assert f and f[0].severity == "high"


def test_timezone_ip_mismatch_is_critical():
    s = load("hardened_chromium.json")
    s["network"]["country"] = "DE"
    rep = evaluate(s)
    f = [x for x in rep.findings if x.id == "consistency.tz-ip-mismatch"]
    assert f and f[0].severity == "critical"
    assert rep.verdict == "DETECTABLE"


def test_uach_missing_on_chromium_flagged():
    s = load("hardened_chromium.json")
    s["uaData"] = None
    rep = evaluate(s)
    assert "consistency.no-uach" in ids(rep)


def test_canvas_noise_detected():
    s = load("hardened_chromium.json")
    s["canvas"]["stableSameDraw"] = False
    rep = evaluate(s)
    assert "fingerprint.canvas-unstable" in ids(rep)


def test_iframe_realm_leak_is_critical():
    s = load("hardened_chromium.json")
    s["automation"]["iframe"]["webdriver"] = True
    rep = evaluate(s)
    f = [x for x in rep.findings if x.id == "automation.iframe-realm-diff"]
    assert f and f[0].severity == "critical"


def test_ua_seen_by_server_mismatch_is_critical():
    s = load("hardened_chromium.json")
    s["network"]["user_agent_seen"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 HeadlessChrome/148.0.0.0"
    rep = evaluate(s)
    f = [x for x in rep.findings if x.id == "network.ua-seen-mismatch"]
    assert f and f[0].severity == "critical"


def test_network_not_measured_is_flagged():
    s = load("hardened_chromium.json")
    s.pop("network")
    rep = evaluate(s)
    assert "network.not-measured" in ids(rep)


def test_stale_browser_flagged():
    s = load("hardened_chromium.json")
    s["navigator"]["userAgent"] = s["navigator"]["userAgent"].replace("148.0.0.0", "112.0.0.0")
    s["uaData"]["high"]["fullVersionList"] = [
        {"brand": "Chromium", "version": "112.0.0.0"},
        {"brand": "Not)A;Brand", "version": "8.0.0.0"},
    ]
    rep = evaluate(s)
    assert "fingerprint.stale-browser" in ids(rep)
