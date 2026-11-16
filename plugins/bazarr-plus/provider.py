import json
import os
import struct
import urllib.parse
import urllib.request

provider_id = "subsontime"
chunk_bytes = 65536
request_timeout_seconds = 120
made_for_this_file = "made for this file"
scores = {
    "movie": {"identifiers": ["title", "year"], "without_hash": 100, "hash": 179, "out_of": 180},
    "episode": {"identifiers": ["series", "year", "season", "episode"], "without_hash": 310, "hash": 359, "out_of": 360},
}


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
    given = (video.get("hashes") or {}).get("opensubtitles")
    path = video.get("original_path") or video.get("name")

    if given and video.get("size"):
        return given, int(video["size"])

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


def candidate_of(entry, path, language, kind):
    weights = scores[kind]
    made_for_file = made_for_this_file in notes_of(entry["label"])
    forced = entry["id"].endswith("-forced")

    return {
        "provider": provider_id,
        "id": entry["id"],
        "language": {**language, "hi": False, "forced": forced},
        "matches": weights["identifiers"] + (["hash"] if made_for_file else []),
        "score": weights["hash"] if made_for_file else weights["without_hash"],
        "score_without_hash": weights["without_hash"],
        "score_out_of": weights["out_of"],
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

        return [
            candidate_of(entry, path, wanted[entry["lang"]], video["kind"])
            for entry in listing.get("subtitles", [])
            if entry.get("lang") in wanted and (path := path_under(base_path, entry["url"])) is not None
        ]

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
