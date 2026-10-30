"""reddic -- detection audit lab and engine-agnostic automation core."""

__version__ = "0.1.0"

from .audit.checks import Report, evaluate  # noqa: F401

__all__ = ["__version__", "Report", "evaluate"]
