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
        {"id": "eng-5", "lang": "eng", "label": "SubDL"},
        {"lang": "eng", "url": f"{origin}/{sealed}/sub/no-id.srt"},
    ]

    return {f"/{sealed}/subtitles/": (200, json.dumps({"subtitles": entries}).encode())}


def path_of(candidate):
    return candidate["provider_payload"]["path"]


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

    def test_uses_the_series_id_and_hashes_the_episode_file(self):
        episode = {
            "kind": "episode",
            "name": None,
            "original_path": write_video(self.directory.name, "Show.S01E02.mkv", 1000),
            "imdb_id": "tt9999999",
            "series_imdb_id": "tt0944947",
            "season": 1,
            "episode": 2,
            "hashes": {},
            "size": None,
        }

        candidates = provider.SubsOnTimeProvider().search(episode, [english], self.config)

        self.assertEqual(
            self.server.requested,
            [f"/{sealed}/subtitles/series/tt0944947:1:2/videoHash=f90c876c5a7f1d56&videoSize=1000&filename=Show.S01E02.mkv.json"],
        )
        self.assertEqual(
            [(path_of(each), each["score"], each["score_out_of"]) for each in candidates],
            [("/sub/second.srt", 359, 360), ("/sub/third.srt?t=d", 358, 360), ("/sub/first.srt", 357, 360), ("/sub/moved.srt", 356, 360), ("/sub/forced.srt", 295, 360)],
        )
        self.assertEqual(
            sorted(candidates[0]["matches"]),
            ["audio_codec", "episode", "release_group", "resolution", "season", "series", "source", "streaming_service", "video_codec", "year"],

        )

    def test_searches_by_name_when_the_file_cannot_be_read(self):
        movie = {"kind": "movie", "name": "/missing/Movie.2020.mkv", "original_path": None, "imdb_id": "tt0000001", "hashes": {}, "size": None}

        provider.SubsOnTimeProvider().search(movie, [english], self.config)

        self.assertEqual(self.server.requested, [f"/{sealed}/subtitles/movie/tt0000001/filename=Movie.2020.mkv.json"])

    def test_scores_every_subtitle_as_a_full_match_made_for_this_file_first_and_forced_last(self):
        candidates = provider.SubsOnTimeProvider().search(self.movie(), [english], self.config)

        self.assertEqual(
            [(path_of(each), each["score"], each["score_without_hash"], each["score_out_of"]) for each in candidates],
            [
                ("/sub/second.srt", 179, 179, 180),
                ("/sub/third.srt?t=d", 178, 178, 180),
                ("/sub/first.srt", 177, 177, 180),
                ("/sub/moved.srt", 176, 176, 180),
                ("/sub/forced.srt", 130, 130, 180),
            ],
        )
        self.assertEqual(
            sorted(candidates[0]["matches"]),
            ["audio_codec", "edition", "release_group", "resolution", "source", "streaming_service", "title", "video_codec", "year"],
        )
        self.assertEqual({each["hash_verifiable"] for each in candidates}, {False})

    def test_keeps_the_language_bazarr_asked_for_and_flags_forced(self):
        candidates = provider.SubsOnTimeProvider().search(self.movie(), [english, brazilian], self.config)
        languages = {path_of(each): each["language"] for each in candidates}

        self.assertEqual(languages["/sub/first.srt"], english)
        self.assertEqual(languages["/sub/forced.srt"], {**english, "forced": True})
        self.assertEqual(languages["/sub/pob.srt"], brazilian)
        self.assertNotIn("/sub/hrv.srt", languages)

    def test_keeps_only_the_path_under_the_install_link_and_skips_broken_entries(self):
        candidates = provider.SubsOnTimeProvider().search(self.movie(), [english], self.config)

        self.assertEqual(
            [each["provider_payload"] for each in candidates],
            [
                {"provider": "subsontime", "path": "/sub/second.srt"},
                {"provider": "subsontime", "path": "/sub/third.srt?t=d"},
                {"provider": "subsontime", "path": "/sub/first.srt"},
                {"provider": "subsontime", "path": "/sub/moved.srt"},
                {"provider": "subsontime", "path": "/sub/forced.srt"},
            ],
        )
        self.assertNotIn(sealed, json.dumps(candidates))

    def test_names_each_subtitle_by_its_path(self):
        first = provider.SubsOnTimeProvider().search(self.movie(), [english], self.config)
        again = provider.SubsOnTimeProvider().search(self.movie(), [english], self.config)
        ids = {path_of(each): each["id"] for each in first}

        self.assertEqual(ids["/sub/first.srt"], "b9c677ad8bd8662dc906b010604dbcd4b372e728a6b76eec9ca957394de726c2")
        self.assertEqual(ids["/sub/second.srt"], "6acb57f64dbdd601ac6843fdacf03ef1370f4ea2b9099ea6dd9540a5c6e1523e")
        self.assertEqual(len(set(ids.values())), 5)
        self.assertEqual([each["id"] for each in again], [each["id"] for each in first])

    def test_never_puts_the_install_link_in_a_search_error(self):
        failing = AddonServer(lambda origin: {"/": (500, b"")})
        config = {"install_link": f"{failing.origin}/{sealed}/manifest.json"}

        with self.assertRaises(urllib.error.HTTPError) as raised:
            provider.SubsOnTimeProvider().search(self.movie(), [english], config)

        failing.close()
        error = raised.exception
        self.assertNotIn(sealed, str(error) + "".join(traceback.format_exception(type(error), error, error.__traceback__)))
        error.close()

    def test_finds_nothing_without_an_install_link(self):
        self.assertEqual(provider.SubsOnTimeProvider().search(self.movie(), [english], {}), [])
        self.assertEqual(self.server.requested, [])


class LongListingTest(unittest.TestCase):
    def setUp(self):
        entries = lambda origin: [
            {"id": f"eng-{index}", "lang": "eng", "label": "SubDL", "url": f"{origin}/{sealed}/sub/{index}.srt"} for index in range(80)
        ]
        self.server = AddonServer(lambda origin: {f"/{sealed}/subtitles/": (200, json.dumps({"subtitles": entries(origin)}).encode())})
        self.config = {"install_link": f"{self.server.origin}/{sealed}/manifest.json"}

    def tearDown(self):
        self.server.close()

    def scores_of(self, video):
        return [each["score"] for each in provider.SubsOnTimeProvider().search(video, [english], self.config)]

    def test_steps_down_to_the_movie_minimum(self):
        movie = {"kind": "movie", "name": "/missing/Movie.2020.mkv", "imdb_id": "tt0000001", "hashes": {}, "size": None}

        self.assertEqual(
            self.scores_of(movie),
            [179, 178, 177, 176, 175] + [164] * 11 + [163, 162, 161, 160] + [149] * 11 + [148, 147, 146, 145]
            + [139] * 6 + [138, 137, 136, 135, 134, 133, 132, 131] + [130] * 31,
        )

    def test_steps_down_to_the_series_minimum(self):
        episode = {"kind": "episode", "name": "/missing/Show.S01E02.mkv", "series_imdb_id": "tt0944947", "season": 1, "episode": 2, "hashes": {}, "size": None}

        self.assertEqual(
            self.scores_of(episode),
            [359, 358, 357, 356, 355] + [339] * 16 + [338, 337, 336, 335, 334, 333, 332, 331, 330, 329, 328, 327, 326, 325]
            + [314] * 11 + [313, 312, 311, 310, 309, 308, 307, 306, 305, 304, 303, 302, 301, 300, 299, 298, 297, 296] + [295] * 16,
        )


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


class SourceInLanguageTest(unittest.TestCase):
    def setUp(self):
        entries = lambda origin: [
            {"id": "eng-best", "lang": "English - OpenSubtitles", "label": "OpenSubtitles", "url": f"{origin}/{sealed}/sub/best.srt"},
            {"id": "eng+hrv-dual", "lang": "English - OpenSubtitles (with Croatian)", "label": "OpenSubtitles (with Croatian)", "url": f"{origin}/{sealed}/sub/dual.srt"},
            {"id": "eng-best-2", "lang": "English - SubDL", "label": "SubDL", "url": f"{origin}/{sealed}/sub/second.srt"},
            {"id": "eng-forced", "lang": "English - SubDL (foreign parts only)", "label": "SubDL (foreign parts only)", "url": f"{origin}/{sealed}/sub/forced.srt"},
            {"id": "pob-best", "lang": "Português (Brasil) - SubDL", "label": "SubDL", "url": f"{origin}/{sealed}/sub/pob.srt"},
            {"id": "hrv-best", "lang": "Hrvatski - Titlovi.com", "label": "Titlovi.com", "url": f"{origin}/{sealed}/sub/hrv.srt"},
        ]
        self.server = AddonServer(lambda origin: {f"/{sealed}/subtitles/": (200, json.dumps({"subtitles": entries(origin)}).encode())})
        self.config = {"install_link": f"{self.server.origin}/{sealed}/manifest.json"}

    def tearDown(self):
        self.server.close()

    def test_reads_the_language_from_the_entry_id(self):
        movie = {"kind": "movie", "name": "/missing/Movie.2020.mkv", "imdb_id": "tt0000001", "hashes": {}, "size": None}

        candidates = provider.SubsOnTimeProvider().search(movie, [english, brazilian], self.config)

        self.assertEqual(
            [(path_of(each), each["language"]["alpha3"], each["language"]["forced"], each["score"]) for each in candidates],
            [
                ("/sub/best.srt", "eng", False, 179),
                ("/sub/dual.srt", "eng", False, 178),
                ("/sub/second.srt", "eng", False, 177),
                ("/sub/forced.srt", "eng", True, 130),
                ("/sub/pob.srt", "por", False, 179),
            ],
        )
