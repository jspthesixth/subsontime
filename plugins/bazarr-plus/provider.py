import functools
import hashlib
import itertools
import json
import os
import re
import struct
import urllib.parse
import urllib.request

provider_id = "subsontime"
chunk_bytes = 65536
request_timeout_seconds = 30
made_for_this_file = "made for this file"
match_weights = {
    "movie": {"title": 60, "year": 40, "source": 30, "edition": 30, "release_group": 15, "audio_codec": 1, "resolution": 1, "video_codec": 1, "streaming_service": 1},
    "episode": {"series": 160, "year": 90, "season": 30, "episode": 30, "source": 25, "release_group": 20, "audio_codec": 1, "resolution": 1, "video_codec": 1, "streaming_service": 1},
}
score_out_of = {"movie": 180, "episode": 360}
minimum_scores = {"movie": 126, "episode": 288}


def match_sets_of(weights, minimum):
    sums = functools.reduce(
        lambda found, key: {**found, **{total + weights[key]: keys + [key] for total, keys in found.items()}},
        weights,
        {0: []},
    )

    return sorted(((total, keys) for total, keys in sums.items() if total >= minimum), reverse=True)


match_ladders = {kind: match_sets_of(weights, minimum_scores[kind]) for kind, weights in match_weights.items()}


def is_plain_url_text(text):
    return all("!" <= character <= "~" for character in text)


def addon_base_of(link):
    trimmed = str(link or "").strip()
    web = "https://" + trimmed[len("stremio://"):] if trimmed.lower().startswith("stremio://") else trimmed

    if not is_plain_url_text(web):
        return None

    try:
        parts = urllib.parse.urlsplit(web)
    except ValueError:
        return None

    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None

    return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/').removesuffix('/manifest.json')}"


def word_sum(chunk):
    return sum(struct.unpack(f"<{len(chunk) // 8}Q", chunk[: len(chunk) // 8 * 8]))


def opensubtitles_hash(path):
    with open(path, "rb") as file:
        size = os.fstat(file.fileno()).st_size
        head = file.read(chunk_bytes)
        file.seek(max(0, size - chunk_bytes))
        tail = file.read(chunk_bytes)

    return f"{(word_sum(head) + word_sum(tail) + size) & 0xFFFFFFFFFFFFFFFF:016x}", size


def fingerprint_of(video):
    path = video.get("original_path") or video.get("name")

    try:
        return opensubtitles_hash(path) if path else None
    except OSError:
        return None


def quoted(value):
    return urllib.parse.quote(str(value), safe="")


def video_id_of(video):
    if video.get("kind") == "movie":
        return f"movie/{quoted(video['imdb_id'])}" if video.get("imdb_id") else None

    if video.get("kind") == "episode" and video.get("series_imdb_id") and video.get("season") is not None and video.get("episode") is not None:
        return f"series/{quoted(video['series_imdb_id'])}:{quoted(video['season'])}:{quoted(video['episode'])}"

    return None


def extras_of(video):
    path = video.get("original_path") or video.get("name") or ""
    name = f"filename={urllib.parse.quote(os.path.basename(path), safe='')}"
    fingerprint = fingerprint_of(video)

    return name if fingerprint is None else f"videoHash={fingerprint[0]}&videoSize={fingerprint[1]}&{name}"


def addon_code_of(language):
    alpha3 = language.get("alpha3")

    if alpha3 == "por" and language.get("country_alpha2") == "BR":
        return "pob"

    if alpha3 == "zho" and (language.get("country_alpha2") in ("TW", "HK") or language.get("script") == "Hant"):
        return "zht"

    return alpha3


def path_under(base_path, url):
    parts = urllib.parse.urlsplit(url)

    if not parts.path.startswith(base_path + "/"):
        return None

    return parts.path[len(base_path):] + (f"?{parts.query}" if parts.query else "")


def notes_of(label):
    _, separator, notes = label.rpartition(" (")

    return notes.removesuffix(")").split(", ") if separator and notes.endswith(")") else []


def fetch(url):
    with urllib.request.urlopen(url, timeout=request_timeout_seconds) as response:
        return response.read()


def matches_at(kind, position):
    ladder = match_ladders[kind]
    target = max(ladder[0][0] - position, minimum_scores[kind])

    return next(((total, keys) for total, keys in ladder if total <= target), ladder[-1])


def is_complete(entry):
    return isinstance(entry, dict) and all(isinstance(entry.get(key), str) for key in ("id", "lang", "label", "url"))


def lang_of(entry):
    code = re.match(r"([a-z]{3})[-+]", entry["id"])

    return code.group(1) if code else entry["lang"]


def is_forced(entry):
    return entry["id"].endswith("-forced")


def is_dialogue(entry):
    return entry["id"].endswith("-dialogue")


def ranked(placed):
    ordered = sorted(placed, key=lambda pair: (lang_of(pair[0]), is_forced(pair[0]), is_dialogue(pair[0]), made_for_this_file not in notes_of(pair[0]["label"])))

    return [
        (entry, path, position)
        for _, group in itertools.groupby(ordered, key=lambda pair: lang_of(pair[0]))
        for position, (entry, path) in enumerate(group)
    ]


def candidate_of(entry, path, position, language, kind):
    forced = is_forced(entry)
    score, matches = match_ladders[kind][-1] if forced else matches_at(kind, position)

    return {
        "provider": provider_id,
        "id": hashlib.sha256(path.encode()).hexdigest(),
        "language": {**language, "hi": False, "forced": forced},
        "matches": matches,
        "score": score,
        "score_without_hash": score,
        "score_out_of": score_out_of[kind],
        "hash_verifiable": False,
        "hearing_impaired_verifiable": False,
        "hearing_impaired": False,
        "display": {"release": entry["label"]},
        "provider_payload": {"provider": provider_id, "path": path},
    }


class SubsOnTimeProvider:
    def search(self, video, languages, config):
        addon_base = addon_base_of(config.get("install_link"))
        video_id = video_id_of(video)
        wanted = {addon_code_of(language): language for language in languages}

        if addon_base is None or video_id is None or not wanted:
            return []

        listing = json.loads(fetch(f"{addon_base}/subtitles/{video_id}/{extras_of(video)}.json"))
        base_path = urllib.parse.urlsplit(addon_base).path

        placed = [
            (entry, path)
            for entry in listing.get("subtitles", [])
            if is_complete(entry) and not entry["id"].endswith("-dual") and lang_of(entry) in wanted and (path := path_under(base_path, entry["url"])) is not None
        ]

        return [candidate_of(entry, path, position, wanted[lang_of(entry)], video["kind"]) for entry, path, position in ranked(placed)]

    def download(self, provider_payload, language, config):
        addon_base = addon_base_of(config.get("install_link"))
        path = str(provider_payload.get("path") or "")

        if addon_base is None:
            raise ValueError("Add the install link in the Subs On Time provider settings.")

        if not path.startswith("/") or not is_plain_url_text(path):
            raise ValueError("Unknown Subs On Time subtitle.")

        return {
            "content": fetch(addon_base + path),
            "content_type": "application/x-subrip",
            "format": "srt",
            "encoding": "utf-8",
        }
