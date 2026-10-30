import json
import pathlib

from reddic.audit import report as rp
from reddic.audit.checks import evaluate

FIX = pathlib.Path(__file__).parent / "fixtures"


def load(name):
    return json.loads((FIX / name).read_text())


def test_html_contains_score_and_verdict():
    rep = evaluate(load("vanilla_playwright.json"))
    html = rp.render_html(rep)
    assert str(rep.score) in html
    assert rep.verdict in html
    assert "Findings" in html


def test_html_escapes_user_agent_xss():
    s = load("hardened_chromium.json")
    s["navigator"]["userAgent"] = "<script>alert(1)</script>"
    html = rp.render_html(evaluate(s))
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html


def test_write_json_and_html(tmp_path):
    rep = evaluate(load("hardened_chromium.json"))
    j = rp.write_json(rep.as_dict(), str(tmp_path / "r.json"))
    h = rp.write_html(rep, str(tmp_path / "r.html"))
    assert json.loads(pathlib.Path(j).read_text())["score"] == rep.score
    assert "<html" in pathlib.Path(h).read_text()


def test_terminal_with_and_without_colour():
    rep = evaluate(load("vanilla_playwright.json"))
    plain = rp.terminal(rep, color=False)
    assert "\033[" not in plain
    assert "DETECTABLE" in plain
    assert "\033[" in rp.terminal(rep, color=True)
