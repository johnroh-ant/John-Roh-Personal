"""Tiny stdlib HTTP helper.

Deliberately zero third-party dependencies: cron jobs run under the bare
system python3 (no pip packages), so the app must work with the standard
library alone. Only simple GETs returning JSON are needed.
"""

import socket
import urllib.error
import urllib.parse
import urllib.request


class NetworkError(RuntimeError):
    """Transport-level failure (DNS, TLS, refused, timeout).

    The message carries only the exception type name — never the URL —
    so query-string credentials can never leak into logs.
    """


def get(url, params=None, timeout=30):
    """GET url?params -> (status_code, body_text). HTTP error statuses are
    returned (with their body), not raised; transport failures raise
    NetworkError."""
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    # an honest, plain UA: ESPN's CDN 403s spoofed browser UAs (no
    # matching TLS fingerprint) but serves simple identified clients fine
    req = urllib.request.Request(
        url, headers={"User-Agent": "sportsbook/1.0",
                      "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")
        except OSError:
            body = ""
        return e.code, body
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        raise NetworkError(type(e).__name__) from None
