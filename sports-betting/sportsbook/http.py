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
    last = (0, "")
    for headers in _HEADER_SETS:
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode("utf-8", "replace")
            except OSError:
                body = ""
            last = (e.code, body)
            if e.code == 403:
                continue  # agent-based CDN block: retry as the other identity
            return last
        except (urllib.error.URLError, socket.timeout, OSError) as e:
            raise NetworkError(type(e).__name__) from None
    return last


# Client identities, tried in order; a 403 falls through to the next.
# ESPN's CDN applies per-network bot rules that shift over time: the
# custom "sportsbook/1.0" agent served fine for weeks and then started
# getting 403s on residential networks while urllib's stock identity
# passed (and a spoofed browser UA is 403d elsewhere). Trying both real
# identities keeps settlement working when the rules move again.
_HEADER_SETS = (
    {},  # urllib's stock identity (Python-urllib/x.y)
    {"User-Agent": "sportsbook/1.0", "Accept": "application/json"},
)
