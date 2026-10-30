"""Engine-agnostic browser adapter.

The whole point: the audit and the later profile/queue layers must not care
which stealth engine is running. Each adapter exposes the same four verbs.
"""

from __future__ import annotations

import os
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class LaunchConfig:
    headless: bool = False
    proxy: Optional[str] = None            # socks5://user:pass@host:port
    user_data_dir: Optional[str] = None
    window: tuple = (1366, 900)
    timezone: Optional[str] = None         # e.g. "Asia/Dhaka"
    locale: str = "en-US"
    language: str = "en-US,en"
    extra_args: List[str] = field(default_factory=list)
    executable: Optional[str] = None       # force system Chrome/Firefox
    channel: Optional[str] = None          # "chrome", "msedge", "chromium"
    humanize: bool = True

    def apply_env(self) -> None:
        """Timezone/locale must be set before the browser process spawns.

        Chromium reads TZ at startup and derives Intl from it. There is no
        reliable runtime override that also satisfies the Intl API, so the
        process environment is the only correct place for it.
        """
        if self.timezone:
            os.environ["TZ"] = self.timezone
            try:
                time.tzset()
            except AttributeError:  # pragma: no cover - windows
                pass
        if self.language:
            os.environ["LANGUAGE"] = self.language.replace(",", ":")
            os.environ["LANG"] = self.language.split(",")[0].replace("-", "_") + ".UTF-8"

    def chromium_args(self) -> List[str]:
        w, h = self.window
        args = [
            f"--window-size={w},{h}",
            f"--lang={self.locale}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
            "--enable-features=NetworkService",
            "--force-color-profile=srgb",
        ]
        if self.headless:
            args += ["--headless=new", "--hide-scrollbars", "--mute-audio"]
        if self.proxy:
            args.append(f"--proxy-server={strip_proxy_auth(self.proxy)}")
        return args + list(self.extra_args)


def strip_proxy_auth(proxy: str) -> str:
    """Chromium's CLI accepts an unauthenticated proxy URL only.

    Authenticated proxies need an extension or an engine-level hook. Returning
    host:port here keeps the launch valid and makes the limitation visible in
    the audit instead of failing mysteriously at connect time.
    """
    if "@" not in proxy:
        return proxy
    scheme, _, rest = proxy.partition("://")
    if not rest:
        return proxy
    _, _, hostport = rest.rpartition("@")
    return f"{scheme}://{hostport}"


class Engine(ABC):
    """Minimal contract used by audit/queue/lab."""

    name: str = "base"

    def __init__(self, config: LaunchConfig):
        self.config = config
        self._started = False

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def goto(self, url: str, wait: str = "domcontentloaded") -> None: ...

    @abstractmethod
    async def evaluate(self, expression: str, arg: Any = None) -> Any: ...

    @abstractmethod
    async def screenshot(self, path: str, full_page: bool = False) -> Optional[str]: ...

    @abstractmethod
    async def close(self) -> None: ...

    async def __aenter__(self) -> "Engine":
        await self.start()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    # -- convenience ------------------------------------------------------- #
    async def run_probe(self, probe_js: str) -> Dict[str, Any]:
        return await self.evaluate(probe_js) or {}

    def describe(self) -> Dict[str, Any]:
        return {
            "engine": self.name,
            "headless": self.config.headless,
            "proxy_set": bool(self.config.proxy),
            "timezone": self.config.timezone,
            "locale": self.config.locale,
            "window": list(self.config.window),
        }


def get_engine(kind: str, config: LaunchConfig) -> Engine:
    kind = (kind or "nodriver").lower()
    if kind in ("nodriver", "uc", "undetected"):
        from .nodriver_engine import NodriverEngine

        return NodriverEngine(config)
    if kind in ("patchright", "playwright", "pw", "camoufox"):
        from .playwright_engine import PlaywrightEngine

        return PlaywrightEngine(config, flavour=kind)
    raise ValueError(
        f"unknown engine {kind!r}; choose from nodriver, patchright, playwright, camoufox"
    )


ENGINE_NAMES = ("nodriver", "patchright", "playwright", "camoufox")
