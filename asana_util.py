"""
Shared Asana HTTP helper.

Asana rate-limits (HTTP 429) when the story-fetching ETLs scan many tickets in a
burst — and an uncaught 429 was crashing uat_moves / reopens / cycle_time, freezing
their tables. get_json() retries on 429 (honoring Retry-After) and transient 5xx /
network errors with capped exponential backoff, and re-raises 403/404 so callers
can skip inaccessible/deleted tasks.
"""
import time
import json
import urllib.request
import urllib.error

ASANA = "https://app.asana.com/api/1.0"


def get_json(path_or_url, pat, tries=6):
    url = path_or_url if str(path_or_url).startswith("http") else ASANA + path_or_url
    h = {"Authorization": "Bearer " + pat}
    delay = 2
    last = None
    for _ in range(tries):
        try:
            return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60).read())
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429 or 500 <= e.code < 600:
                ra = e.headers.get("Retry-After") if e.code == 429 else None
                time.sleep(min(int(ra), 60) if (ra and str(ra).isdigit()) else delay)
                delay = min(delay * 2, 60)
                continue
            raise  # 403 / 404 / other -> caller decides (usually skip)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
            time.sleep(delay)
            delay = min(delay * 2, 60)
            continue
    if isinstance(last, Exception):
        raise last
    raise RuntimeError("Asana GET failed after retries: " + url)
