import json
import pathlib
import threading
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from reddic.lab.server import Handler

FIX = pathlib.Path(__file__).parent / "fixtures"


@pytest.fixture()
def server(tmp_path):
    Handler.out_dir = str(tmp_path)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def get(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return r.status, r.read()


def post(url, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, json.loads(r.read())


def test_health(server):
    status, body = get(server + "/health")
    assert status == 200
    assert json.loads(body)["ok"] is True


def test_index_and_probe_are_served(server):
    status, body = get(server + "/")
    assert status == 200 and b"reddic" in body
    status, body = get(server + "/probe.js")
    assert status == 200 and b"async () =>" in body


def test_submit_scores_and_writes_reports(server, tmp_path):
    signals = json.loads((FIX / "vanilla_playwright.json").read_text())
    status, res = post(server + "/submit", {"signals": signals})
    assert status == 200
    assert res["verdict"] == "DETECTABLE"
    assert res["score"] < 40
    assert res["critical"]

    status, rep = get(server + res["html"])
    assert status == 200 and b"Detection audit" in rep

    status, raw = get(server + res["json"])
    assert json.loads(raw)["report"]["score"] == res["score"]


def test_submit_rejects_bad_json(server):
    req = urllib.request.Request(
        server + "/submit", data=b"not json", headers={"Content-Type": "application/json"}
    )
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(req, timeout=10)
    assert exc.value.code == 400


def test_unknown_route_404(server):
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(server + "/nope", timeout=10)
    assert exc.value.code == 404
