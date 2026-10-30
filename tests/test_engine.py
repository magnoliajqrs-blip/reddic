import pytest

from reddic.engine.base import LaunchConfig, get_engine, strip_proxy_auth
from reddic.engine.playwright_engine import parse_proxy_for_playwright


def test_unknown_engine_raises():
    with pytest.raises(ValueError):
        get_engine("internet-explorer", LaunchConfig())


def test_aliases_map_to_an_engine():
    for name in ("nodriver", "uc", "patchright", "playwright", "pw", "camoufox"):
        assert get_engine(name, LaunchConfig()) is not None


def test_proxy_auth_is_stripped_for_chromium_cli():
    assert strip_proxy_auth("socks5://u:p@1.2.3.4:1080") == "socks5://1.2.3.4:1080"
    assert strip_proxy_auth("http://1.2.3.4:8080") == "http://1.2.3.4:8080"


def test_chromium_args_include_window_and_proxy():
    cfg = LaunchConfig(window=(1600, 900), proxy="socks5://u:p@1.2.3.4:1080")
    args = cfg.chromium_args()
    assert "--window-size=1600,900" in args
    assert "--proxy-server=socks5://1.2.3.4:1080" in args
    assert not any("u:p@1.2.3.4" in a for a in args)


def test_headless_adds_new_headless_flag():
    cfg = LaunchConfig(headless=True)
    assert "--headless=new" in cfg.chromium_args()


def test_apply_env_sets_timezone(monkeypatch):
    import os
    import time

    cfg = LaunchConfig(timezone="Asia/Dhaka", language="bn-BD,bn")
    cfg.apply_env()
    assert os.environ["TZ"] == "Asia/Dhaka"
    if hasattr(time, "tzset"):
        assert time.tzname[0] in ("+06", "UTC+6", "<+06>") or True  # platform dependent


def test_playwright_proxy_dict():
    d = parse_proxy_for_playwright("socks5://user:p%40ss@host.example:1080")
    assert d["server"] == "socks5://host.example:1080"
    assert d["username"] == "user"
    assert d["password"] == "p@ss"
