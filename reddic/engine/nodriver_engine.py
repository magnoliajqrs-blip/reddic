"""nodriver adapter -- the default engine.

Why nodriver: it speaks CDP directly without the Playwright shim, so it does not
emit the Runtime.enable / Target.setAutoAttach startup pattern, and it never
touches navigator.webdriver. In the 2026 public benchmarks it is the only engine
with zero blocked targets.

Install:  pip install 'reddic[nodriver]'
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, Optional

from .base import Engine, LaunchConfig


class NodriverEngine(Engine):
    name = "nodriver"

    def __init__(self, config: LaunchConfig):
        super().__init__(config)
        self.browser: Any = None
        self.tab: Any = None

    async def start(self) -> None:
        try:
            import nodriver as uc  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "nodriver is not installed. Run: pip install 'reddic[nodriver]'"
            ) from exc

        self.config.apply_env()
        kwargs: Dict[str, Any] = {
            "headless": self.config.headless,
            "browser_args": self.config.chromium_args(),
            "lang": self.config.locale,
        }
        if self.config.user_data_dir:
            kwargs["user_data_dir"] = self.config.user_data_dir
        if self.config.executable:
            kwargs["browser_executable_path"] = self.config.executable
        # sandbox off is required in most containers; harmless elsewhere.
        kwargs["sandbox"] = False

        self.browser = await uc.start(**kwargs)
        self._started = True

    async def goto(self, url: str, wait: str = "domcontentloaded") -> None:
        if self.browser is None:
            raise RuntimeError("engine not started")
        self.tab = await self.browser.get(url)
        # nodriver resolves .get() after load; give late scripts a beat.
        await asyncio.sleep(0.6)

    async def evaluate(self, expression: str, arg: Any = None) -> Any:
        if self.tab is None:
            raise RuntimeError("no page open; call goto() first")
        expr = expression
        if arg is not None:
            # nodriver has no argument passing, so inline it safely.
            payload = json.dumps(arg)
            expr = f"({expression})({payload})"
        else:
            stripped = expression.lstrip()
            if stripped.startswith("async ") or stripped.startswith("function"):
                expr = f"({expression})()"
        value = await self.tab.evaluate(expr, await_promise=True)
        # nodriver may return a RemoteObject wrapper depending on version.
        return getattr(value, "value", value)

    async def screenshot(self, path: str, full_page: bool = False) -> Optional[str]:
        if self.tab is None:
            return None
        try:
            await self.tab.save_screenshot(path, full_page=full_page)
            return path
        except Exception:
            return None

    async def close(self) -> None:
        if self.browser is not None:
            try:
                self.browser.stop()
            except Exception:
                pass
        self.browser = None
        self.tab = None
        self._started = False
