"""Live comparison against Google's keyless web translation endpoint.

Sends ONLY the public, original test sentences in tests/live/cases.json
(written for this project, no personal data) to translate.googleapis.com,
one request at a time with a pause between calls. Output: tests/live/google-results.json

Run (optional, makes real network requests):  python -I tests/live/google_compare.py
"""
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
ENDPOINT = "https://translate.googleapis.com/translate_a/single"


CACHE_FILE = HERE / "google-cache.json"
CACHE = json.loads(CACHE_FILE.read_text(encoding="utf-8")) if CACHE_FILE.exists() else {}
FAILURES = []


def translate(text: str) -> str:
    if text in CACHE:
        return CACHE[text]
    for attempt in range(2):  # one retry at most; never loop on errors
        try:
            CACHE[text] = _translate(text)
            CACHE_FILE.write_text(json.dumps(CACHE, ensure_ascii=False, indent=1), encoding="utf-8")
            time.sleep(1.5)
            return CACHE[text]
        except urllib.error.HTTPError as error:
            FAILURES.append({"text": text[:60], "status": error.code, "attempt": attempt + 1})
            time.sleep(20)
    return "<<未取得：服務錯誤>>"


def _translate(text: str) -> str:
    query = urllib.parse.urlencode({"client": "gtx", "sl": "en", "tl": "zh-TW", "dt": "t", "q": text})
    request = urllib.request.Request(ENDPOINT + "?" + query, headers={"User-Agent": "parallel-read-test"})
    with urllib.request.urlopen(request, timeout=20) as response:
        data = json.loads(response.read().decode("utf-8"))
    return "".join(segment[0] for segment in data[0] if segment and isinstance(segment[0], str))


def main() -> int:
    cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    results = []
    for case in cases:
        entry = {"id": case["id"], "source": case["source"]}
        # "old" = the fragments the 0.1.1/0.2.0 extractor actually produced
        # in Chromium for this paragraph, each translated in isolation.
        entry["old_fragments"] = []
        for fragment in case["old_fragments"]:
            entry["old_fragments"].append({"en": fragment, "zh": translate(fragment)})
        # "new" = the complete paragraph text produced by the new extractor.
        entry["new_text"] = case.get("new_text", case["source"])
        entry["new_zh"] = translate(entry["new_text"])
        results.append(entry)
        print(case["id"], "ok", file=sys.stderr)
    print("service failures observed:", json.dumps(FAILURES), file=sys.stderr)
    (HERE / "google-results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
