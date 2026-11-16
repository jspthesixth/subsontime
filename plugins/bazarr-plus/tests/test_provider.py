import base64
import hashlib
import http.server
import importlib.util
import json
import tempfile
import threading
import traceback
import unittest
import urllib.error
from pathlib import Path

plugin_dir = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("subsontime_provider", plugin_dir / "provider.py")
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)

sealed = "sealed-config-segment"
english = {"alpha3": "eng", "alpha2": "en", "country_alpha2": None, "script": None, "hi": False, "forced": False}
brazilian = {"alpha3": "por", "alpha2": "pt", "country_alpha2": "BR", "script": None, "hi": False, "forced": False}


def generated(size):
    state = 1
    data = bytearray()

    for _ in range(size):
        state = (state * 1103515245 + 12345) & 0xFFFFFFFF
        data.append((state >> 16) & 255)

    return bytes(data)


def write_video(directory, name, size):
    path = Path(directory) / name
    path.write_bytes(generated(size))

    return str(path)


class AddonServer:
    def __init__(self, responses):
        self.requested = []
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                server.requested.append(self.path)
                status, body = next(
                    (value for prefix, value in responses(server.origin).items() if self.path.startswith(prefix)),
                    (404, b""),
                )
                self.send_response(status)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.http = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.http.server_port}"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def close(self):
        self.http.shutdown()
        self.http.server_close()


def listing(origin):
    entries = [
        {"id": "eng-1", "lang": "eng", "label": "SubDL", "url": f"{origin}/{sealed}/sub/first.srt"},
        {"id": "eng-2", "lang": "eng", "label": "OpenSubtitles (made for this file)", "url": f"{origin}/{sealed}/sub/second.srt"},
        {"id": "eng-dialogue", "lang": "eng", "label": "OpenSubtitles (made for this file, dialogue only)", "url": f"{origin}/{sealed}/sub/third.srt?t=d"},
        {"id": "eng-forced", "lang": "eng", "label": "OpenSubtitles (foreign parts only)", "url": f"{origin}/{sealed}/sub/forced.srt"},
        {"id": "pob-1", "lang": "pob", "label": "SubDL", "url": f"{origin}/{sealed}/sub/pob.srt"},
        {"id": "hrv-1", "lang": "hrv", "label": "Titlovi", "url": f"{origin}/{sealed}/sub/hrv.srt"},
        {"id": "eng-3", "lang": "eng", "label": "SubDL", "url": f"{origin}/elsewhere/sub/other.srt"},
        {"id": "eng-4", "lang": "eng", "label": "SubDL", "url": f"http://other.example/{sealed}/sub/moved.srt"},
    ]

    return {f"/{sealed}/subtitles/": (200, json.dumps({"subtitles": entries}).encode())}


class OpenSubtitlesHashTest(unittest.TestCase):
    def test_matches_the_typescript_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(provider.opensubtitles_hash(write_video(directory, "large.mkv", 204800)), ("7e41b4dbe9b10c2e", 204800))
            self.assertEqual(provider.opensubtitles_hash(write_video(directory, "small.mkv", 1000)), ("f90c876c5a7f1d56", 1000))


class InstallLinkTest(unittest.TestCase):
    def test_normalizes_to_the_addon_base(self):
        cases = {
            "https://subsontime.com/abc/manifest.json": "https://subsontime.com/abc",
            "  stremio://subsontime.com/abc/manifest.json\n": "https://subsontime.com/abc",
            "https://subsontime.com/abc/": "https://subsontime.com/abc",
            "http://localhost:3000/abc/manifest.json": "http://localhost:3000/abc",
        }

        for link, addon_base in cases.items():
            self.assertEqual(provider.addon_base_of(link), addon_base)

    def test_rejects_anything_else(self):
        for link in [None, "", "   ", "subsontime.com/abc/manifest.json", "ftp://subsontime.com/abc/manifest.json", "https://subsontime.com/a b/manifest.json", "https://subsontime.com/a\x00b"]:
            self.assertIsNone(provider.addon_base_of(link))


class ManifestTest(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((plugin_dir / "provider.json").read_text())

    def test_marks_the_install_link_secret(self):
        self.assertEqual(self.manifest["secret_fields"], ["install_link"])
        self.assertEqual(self.manifest["config_schema"]["properties"]["install_link"]["secret"], True)
        self.assertEqual(list(self.manifest["config_schema"]["properties"]), ["install_link"])

    def test_hashes_match_the_files(self):
        digest = hashlib.sha256()

        for path in sorted(self.manifest["files"]):
            data = (plugin_dir / path).read_bytes()
            digest.update(path.encode() + b"\0" + str(len(data)).encode() + b"\0" + data + b"\0")

        self.assertEqual(
            {"files": self.manifest["files"], "bundle_sha256": self.manifest["bundle_sha256"]},
            {"files": {"provider.py": hashlib.sha256((plugin_dir / "provider.py").read_bytes()).hexdigest()}, "bundle_sha256": digest.hexdigest()},
        )


class SearchTest(unittest.TestCase):
    def setUp(self):
        self.server = AddonServer(listing)
        self.config = {"install_link": f"  {self.server.origin}/{sealed}/manifest.json "}
        self.directory = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.server.close()
        self.directory.cleanup()

    def movie(self):
        return {
            "kind": "movie",
            "name": write_video(self.directory.name, "Night of the Living Dead (1968).mkv", 204800),
            "original_path": None,
            "imdb_id": "tt0063350",
            "hashes": {},
            "size": None,
        }

    def test_sends_only_the_hash_size_and_name(self):
        provider.SubsOnTimeProvider().search(self.movie(), [english], self.config)

        self.assertEqual(
            self.server.requested,
            [f"/{sealed}/subtitles/movie/tt0063350/videoHash=7e41b4dbe9b10c2e&videoSize=204800&filename=Night%20of%20the%20Living%20Dead%20%281968%29.mkv.json"],
        )

    def test_uses_the_series_id_and_the_hash_bazarr_gives(self):
        episode = {
            "kind": "episode",
            "name": "/missing/Show.S01E02.mkv",
            "original_path": "/missing/Show.S01E02.mkv",
            "imdb_id": "tt9999999",
            "series_imdb_id": "tt0944947",
            "season": 1,
            "episode": 2,
            "hashes": {"opensubtitles": "0123456789abcdef"},
            "size": 734003200,
        }

        candidates = provider.SubsOnTimeProvider().search(episode, [english], self.config)

        self.assertEqual(
            self.server.requested,
            [f"/{sealed}/subtitles/series/tt0944947:1:2/videoHash=0123456789abcdef&videoSize=734003200&filename=Show.S01E02.mkv.json"],
        )
        self.assertEqual(
            [(each["id"], sorted(each["matches"]), each["score"], each["score_out_of"]) for each in candidates[:2]],
            [("eng-1", ["episode", "season", "series", "year"], 310, 360), ("eng-2", ["episode", "hash", "season", "series", "year"], 359, 360)],
        )

    def test_searches_by_name_when_the_file_cannot_be_read(self):
        movie = {"kind": "movie", "name": "/missing/Movie.2020.mkv", "original_path": None, "imdb_id": "tt0000001", "hashes": {}, "size": None}

        provider.SubsOnTimeProvider().search(movie, [english], self.config)

        self.assertEqual(self.server.requested, [f"/{sealed}/subtitles/movie/tt0000001/filename=Movie.2020.mkv.json"])

    def test_ranks_subtitles_made_for_this_file_first(self):
        candidates = provider.SubsOnTimeProvider().search(self.movie(), [english], self.config)

        self.assertEqual(
            [(each["id"], sorted(each["matches"]), each["score"]) for each in candidates],
            [
                ("eng-1", ["title", "year"], 100),
                ("eng-2", ["hash", "title", "year"], 179),
                ("eng-dialogue", ["hash", "title", "year"], 179),
                ("eng-forced", ["title", "year"], 100),
                ("eng-4", ["title", "year"], 100),
            ],
        )
        self.assertEqual({(each["score_without_hash"], each["score_out_of"], each["hash_verifiable"]) for each in candidates}, {(100, 180, False)})

    def test_keeps_the_language_bazarr_asked_for_and_flags_forced(self):
        candidates = provider.SubsOnTimeProvider().search(self.movie(), [english, brazilian], self.config)
        languages = {each["id"]: each["language"] for each in candidates}

        self.assertEqual(languages["eng-1"], english)
        self.assertEqual(languages["eng-forced"], {**english, "forced": True})
        self.assertEqual(languages["pob-1"], brazilian)
        self.assertNotIn("hrv-1", languages)

    def test_keeps_only_the_path_under_the_install_link(self):
        candidates = provider.SubsOnTimeProvider().search(self.movie(), [english], self.config)
        payloads = {each["id"]: each["provider_payload"] for each in candidates}

        self.assertEqual(payloads["eng-1"], {"provider": "subsontime", "path": "/sub/first.srt"})
        self.assertEqual(payloads["eng-dialogue"], {"provider": "subsontime", "path": "/sub/third.srt?t=d"})
        self.assertEqual(payloads["eng-4"], {"provider": "subsontime", "path": "/sub/moved.srt"})
        self.assertNotIn(sealed, json.dumps(candidates))

    def test_finds_nothing_without_an_install_link(self):
        self.assertEqual(provider.SubsOnTimeProvider().search(self.movie(), [english], {}), [])
        self.assertEqual(self.server.requested, [])


class DownloadTest(unittest.TestCase):
    def setUp(self):
        self.server = AddonServer(lambda origin: {f"/{sealed}/sub/first.srt": (200, b"1\n00:00:01,000 --> 00:00:02,000\nHello\n"), "/": (500, b"")})
        self.config = {"install_link": f"stremio://example.invalid/{sealed}/manifest.json"}

    def tearDown(self):
        self.server.close()

    def test_returns_the_srt_from_the_install_link(self):
        config = {"install_link": f"{self.server.origin}/{sealed}/manifest.json"}

        result = provider.SubsOnTimeProvider().download({"provider": "subsontime", "path": "/sub/first.srt"}, english, config)

        self.assertEqual(self.server.requested, [f"/{sealed}/sub/first.srt"])
        self.assertEqual(
            {**result, "content": base64.b64encode(result["content"]).decode()},
            {
                "content": "MQowMDowMDowMSwwMDAgLS0+IDAwOjAwOjAyLDAwMApIZWxsbwo=",
                "content_type": "application/x-subrip",
                "format": "srt",
                "encoding": "utf-8",
            },
        )

    def test_never_puts_the_install_link_in_an_error(self):
        config = {"install_link": f"{self.server.origin}/{sealed}/manifest.json"}

        with self.assertRaises(urllib.error.HTTPError) as raised:
            provider.SubsOnTimeProvider().download({"provider": "subsontime", "path": "/sub/broken.srt"}, english, config)

        error = raised.exception
        self.assertNotIn(sealed, str(error) + "".join(traceback.format_exception(type(error), error, error.__traceback__)))
        error.close()

    def test_rejects_a_path_that_is_not_under_the_install_link(self):
        for path in ["https://other.example/sub/x.srt", "/sub/a b.srt", "", None]:
            with self.assertRaises(ValueError):
                provider.SubsOnTimeProvider().download({"provider": "subsontime", "path": path}, english, self.config)

    def test_asks_for_the_install_link_when_missing(self):
        with self.assertRaisesRegex(ValueError, "Add the install link"):
            provider.SubsOnTimeProvider().download({"provider": "subsontime", "path": "/sub/first.srt"}, english, {})


if __name__ == "__main__":
    unittest.main()
