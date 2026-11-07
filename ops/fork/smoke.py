#!/usr/bin/env python3
"""Read-only health and authenticated subscription checks. Never log a response body."""
import argparse
import json
import os
import re
import secrets
import stat
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PUBLIC = "https://subboost.krus1987.kdns.fr"


class CheckError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise CheckError(message)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def http(base, path, session=None, data=None):
    url = base.rstrip("/") + path + "?fork_smoke=" + secrets.token_hex(8)
    headers = {"Cache-Control": "no-store, no-cache", "User-Agent": "subboost-fork-smoke"}
    if session:
        require(base == PUBLIC or re.fullmatch(r"http://127\.0\.0\.1:[0-9]+", base), "untrusted cookie destination")
        headers["Cookie"] = "subboost_local_session=" + session
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, headers=headers, data=data)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=8) as response:
            require(response.status == 200, "unexpected HTTP status")
            return response.read(), response.headers
    except (OSError, ValueError):
        raise CheckError("HTTP request failed") from None


def private_json(path):
    file = Path(path)
    s = file.stat()
    require(file.resolve() == file.absolute() and stat.S_ISREG(s.st_mode) and
            s.st_mode & 0o077 == 0 and s.st_uid == os.geteuid(), "unsafe credentials file")
    return json.loads(file.read_bytes())


def business_session(base, path):
    cfg = private_json(path)
    sid = cfg["subscriptionId"]
    require(isinstance(sid, str) and re.fullmatch("[A-Za-z0-9_-]+", sid), "invalid subscription ID")
    token = cfg.get("session")
    if not token:
        require(base == PUBLIC or re.fullmatch(r"http://127\.0\.0\.1:[0-9]+", base), "untrusted login destination")
        data = json.dumps({k: cfg[k] for k in ("username", "password")}).encode()
        _, headers = http(base, "/api/auth/login", data=data)
        from http.cookies import SimpleCookie
        cookies = SimpleCookie()
        for header in headers.get_all("Set-Cookie", []):
            cookies.load(header)
        token = cookies["subboost_local_session"].value
    require(re.fullmatch(r"[A-Za-z0-9_.-]+", token), "invalid session")
    return sid, token


def health(base):
    live = json.loads(http(base, "/api/health/live")[0])
    ready = json.loads(http(base, "/api/health/ready")[0])
    require(live.get("ok") is True and ready.get("ok") is True and ready.get("database") == "ready",
            "health payload mismatch")


def check_site(base, session=None, wait=0):
    deadline = time.monotonic() + wait
    while True:
        try:
            health(base)
            break
        except (CheckError, ValueError):
            print("waiting for live and ready", flush=True)
            if time.monotonic() >= deadline:
                raise CheckError("health deadline exceeded") from None
            time.sleep(2)
    for path in ("/", "/login"):
        page, headers = http(base, path)
        require("text/html" in headers.get("Content-Type", "") and b"<html" in page.lower(), "invalid HTML page")
    if session:
        sid, token = session
        body = json.loads(http(base, "/api/subscriptions/" + sid, session=token)[0])
        item = body["subscription"]
        require(item["id"] == sid and isinstance(item["config"], dict) and
                isinstance(item["urls"], list) and isinstance(item["nodes"], list), "subscription read failed")
    print("live, ready, homepage, login page" + (", decrypted subscription" if session else "") + ": passed", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("base")
    parser.add_argument("--business", type=Path)
    parser.add_argument("--wait", type=int, default=0)
    args = parser.parse_args()
    try:
        base = args.base.rstrip("/")
        check_site(base, business_session(base, args.business) if args.business else None, args.wait)
    except (OSError, KeyError, CheckError, ValueError) as error:
        parser.exit(1, "SubBoost smoke failed (" + type(error).__name__ + ")\n")
