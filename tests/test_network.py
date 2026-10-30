from reddic.audit.network import (
    NetworkSignals,
    http2_findings,
    ip_matches_geo,
    parse_ja4_payload,
)

PEET = {
    "tls": {
        "ja3": "771,4865-4866-4867,0-23-65281,29-23-24,0",
        "ja3_hash": "cd08e31494f9531f560d64c695473da9",
        "ja4": "t13d1516h2_8daaf6152771_b186095e22b6",
    },
    "http2": {
        "akamai_fingerprint": "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
        "akamai_fingerprint_hash": "52d84b11737d980aef856699f885ca86",
        "sent_frames": [{"settings": "1:65536;2:0;4:6291456;6:262144"}],
    },
    "user_agent": "Mozilla/5.0 Chrome/148.0.0.0",
    "http_version": "h2",
    "ip": "103.1.2.3",
    "geoip": {"country": "BD"},
}

BROWSERLEAKS = {
    "ja3_hash": "abc123",
    "akamai_hash": "def456",
    "user_agent": "Mozilla/5.0 Firefox/135.0",
}


def test_parse_peet_shape():
    sig = parse_ja4_payload(PEET)
    assert sig.ok
    assert sig.ja4.startswith("t13d")
    assert sig.ja3_hash
    assert sig.akamai_fingerprint_hash
    assert sig.user_agent_seen.startswith("Mozilla/5.0 Chrome")
    assert sig.raw["sent_settings"].startswith("1:65536")


def test_parse_browserleaks_shape():
    sig = parse_ja4_payload(BROWSERLEAKS)
    assert sig.ok
    assert sig.ja3_hash == "abc123"
    assert sig.user_agent_seen.startswith("Mozilla/5.0 Firefox")


def test_http2_chrome_settings_pass():
    sig = NetworkSignals(ok=True, raw={"sent_settings": "1:65536;2:0;4:6291456;6:262144"})
    assert http2_findings(sig, "chromium") == []


def test_http2_firefox_settings_fail_chromium_check():
    sig = NetworkSignals(ok=True, raw={"sent_settings": "1:65536;2:0;4:131072;5:16384"})
    findings = http2_findings(sig, "chromium")
    assert any("Firefox-only" in f for f in findings)


def test_http2_missing_enable_push_flags():
    sig = NetworkSignals(ok=True, raw={"sent_settings": "1:65536;2:5;4:1048576"})
    findings = http2_findings(sig, "chromium")
    assert findings
    assert any("ENABLE_PUSH" in f for f in findings)


def test_http2_firefox_window_size():
    sig = NetworkSignals(ok=True, raw={"sent_settings": "4:65535"})
    assert http2_findings(sig, "firefox")


def test_ip_matches_geo():
    assert ip_matches_geo("1.2.3.4", "BD", "Asia/Dhaka") is None
    assert ip_matches_geo("1.2.3.4", "DE", "Asia/Dhaka") is not None
    assert ip_matches_geo(None, "DE", "Asia/Dhaka") is None
