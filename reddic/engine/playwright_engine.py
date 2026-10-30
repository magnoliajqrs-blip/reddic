"""Playwright-family adapter: patchright | playwright | camoufox.

One adapter, three flavours -- they share the same API, only the import and the
launch options differ. This is deliberate: when a target changes its detection
model you swap one string, not a codebase.

Install:
    pip install 'reddic[patchright]'   # recommended Chromium path
    pip install 'reddic[playwright]'   # baseline, for A/B comparison
    pip install 'reddic[camoufox]'     # Firefox path
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional

from .base import Engine, LaunchConfig

PATCHRIGHT_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-service-autorun",
    "--export-tagged-pdf",
    "--disable-search-engine-choice-screen",
]


class PlaywrightEngine(Engine):
    def __init__(self, config: LaunchConfig, flavour: str = "patchright"):
        super().__init__(config)
        self.flavour = flavour
        self.name = flavour if flavour in ("patchright", "camoufox") else "playwright"
        self._pw: Any = None
        self._browser: Any = None
        self._context: Any = None
        self.page: Any = None
        self._camoufox_cm: Any = None

    async def start(self) -> None:
        self.config.apply_env()
        if self.flavour == "camoufox":
            await self._start_camoufox()
        elif self.flavour == "patchright":
            await self._start_patchright()
        else:
            await self._start_plain_playwright()
        self._started = True

    # -- flavours ---------------------------------------------------------- #
    async def _start_camoufox(self) -> None:
        try:
            from camoufox.async_api import AsyncCamoufox  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "camoufox is not installed. Run: pip install 'reddic[camoufox]'"
            ) from exc

        opts: Dict[str, Any] = {
            "headless": self.config.headless,
            "humanize": self.config.humanize,
            "locale": self.config.locale.split("-")[0],
        }
        if self.config.proxy:
            opts["proxy"] = parse_proxy_for_playwright(self.config.proxy)
            opts["geoip"] = True  # lets Camoufox derive tz/locale from the IP
        self._camoufox_cm = AsyncCamoufox(**opts)
        self._browser = await self._camoufox_cm.__aenter__()
        self._context = None  # camoufox returns a Browser; context is implicit
        self.page = await self._browser.new_page()

    async def _start_patchright(self) -> None:
        try:
            from patchright.async_api import async_playwright  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "patchright is not installed. Run: pip install 'reddic[patchright]'"
            ) from exc
        self._pw = await async_playwright().start()
        launch: Dict[str, Any] = {
            "headless": self.config.headless,
            # patchright docs: no_chromium/stealth behaviour is the default; the
            # important part is using a real channel so TLS/JA4 is genuine.
            "channel": self.config.channel or "chrome",
            "args": PATCHRIGHT_ARGS + self.config.chromium_args(),
            "no_viewport": True,
        }
        if self.config.executable:
            launch.pop("channel", None)
            launch["executable_path"] = self.config.executable
        try:
            self._context = await self._pw.chromium.launch_persistent_context(
                user_data_dir=self.config.user_data_dir or "",
                proxy=self._proxy_dict(),
                **launch,
            )
            self.page = await self._context.new_page()
        except Exception as exc:  # channel missing on this box
            if "chrome" not in str(exc).lower():
                raise
            launch.pop("channel", None)
            self._context = await self._pw.chromium.launch_persistent_context(
                user_data_dir=self.config.user_data_dir or "",
                proxy=self._proxy_dict(),
                **launch,
            )
            self.page = await self._context.new_page()

    async def _start_plain_playwright(self) -> None:
        try:
            from playwright.async_api import async_playwright  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "playwright is not installed. Run: pip install 'reddic[playwright]'"
            ) from exc
        self._pw = await async_playwright().start()
        launch: Dict[str, Any] = {
            "headless": self.config.headless,
            "args": self.config.chromium_args(),
            "no_viewport": True,
        }
        if self.config.executable:
            launch["executable_path"] = self.config.executable
        elif self.config.channel:
            launch["channel"] = self.config.channel
        self._context = await self._pw.chromium.launch_persistent_context(
            user_data_dir=self.config.user_data_dir or "",
            proxy=self._proxy_dict(),
            **launch,
        )
        self.page = await self._context.new_page()

    # -- helpers ----------------------------------------------------------- #
    def _proxy_dict(self) -> Optional[Dict[str, str]]:
        if not self.config.proxy:
            return None
        return parse_proxy_for_playwright(self.config.proxy)

    # -- contract ---------------------------------------------------------- #
    async def goto(self, url: str, wait: str = "domcontentloaded") -> None:
        if self.page is None:
            raise RuntimeError("engine not started")
        await self.page.goto(url, wait_until=wait, timeout=45_000)
        await asyncio.sleep(0.6)

    async def evaluate(self, expression: str, arg: Any = None) -> Any:
        if self.page is None:
            raise RuntimeError("no page open; call goto() first")
        return await self.page.evaluate(expression, arg)

    async def screenshot(self, path: str, full_page: bool = False) -> Optional[str]:
        if self.page is None:
            return None
        try:
            await self.page.screenshot(path=path, full_page=full_page)
            return path
        except Exception:
            return None

    async def close(self) -> None:
        try:
            if self._camoufox_cm is not None:
                await self._camoufox_cm.__aexit__(None, None, None)
            elif self._context is not None:
                await self._context.close()
            elif self._browser is not None:
                await self._browser.close()
        except Exception:
            pass
        try:
            if self._pw is not None:
                await self._pw.stop()
        except Exception:
            pass
        self._pw = self._browser = self._context = self.page = None
        self._started = False

    def describe(self) -> Dict[str, Any]:
        d = super().describe()
        d["flavour"] = self.flavour
        d["channel"] = self.config.channel
        return d


def parse_proxy_for_playwright(proxy: str) -> Dict[str, str]:
    """socks5://user:pass@host:port -> playwright proxy dict."""
    from urllib.parse import unquote, urlparse

    p = urlparse(proxy)
    d: Dict[str, str] = {"server": f"{p.scheme}://{p.hostname}:{p.port}"}
    if p.username:
        d["username"] = unquote(p.username)
    if p.password:
        d["password"] = unquote(p.password)
    return d
