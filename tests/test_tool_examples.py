"""Regression checks using the real input assets shipped with the workbench."""
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image
import app as server
from tools.image_pipeline import remove_color

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "web/static/examples/bytepet"
CATALOG = json.loads((EXAMPLES / "example.json").read_text(encoding="utf-8"))


class ToolExampleTests(unittest.TestCase):
    def setUp(self):
        (ROOT / ".runtime").mkdir(exist_ok=True)
        self.storage = tempfile.TemporaryDirectory(dir=ROOT / ".runtime", prefix="test-tools-")
        self.previous_directory = server.DATA_DIR
        server.DATA_DIR = Path(self.storage.name)
        self.client = server.app.test_client()
        self.responses = []

    def tearDown(self):
        for response in self.responses:
            response.close()
            stream = response.request.environ.get("wsgi.input")
            if stream:
                stream.close()
        server.DATA_DIR = self.previous_directory
        self.storage.cleanup()

    def post(self, files, options):
        payload = [(io.BytesIO(path.read_bytes()), path.name) for path in files]
        response = self.client.post("/api/process", data={
            "options": json.dumps(options), "files": payload
        }, content_type="multipart/form-data")
        self.responses.append(response)
        return response

    def get(self, url):
        response = self.client.get(url)
        self.responses.append(response)
        return response

    def output(self, job, group=0):
        image = Image.open(io.BytesIO(self.get(job["groups"][group]["frames"][0]["url"]).data))
        return image.convert("RGBA")

    def green(self, key="star"):
        return EXAMPLES / next(entry["file"] for entry in CATALOG["cutout_states"] if entry["key"] == key)

    def originals(self, key="calm"):
        return [EXAMPLES / path for path in next(entry["frame_files"] for entry in CATALOG["states"] if entry["key"] == key)]

    def test_green_examples_are_untouched_local_uploads(self):
        for entry in CATALOG["cutout_states"]:
            original = ROOT / entry["source"]
            bundled = EXAMPLES / entry["file"]
            if original.exists():
                self.assertEqual(original.read_bytes(), bundled.read_bytes())
            self.assertEqual(hashlib.sha256(bundled.read_bytes()).hexdigest(), entry["sha256"])
            with Image.open(bundled) as image:
                self.assertEqual(image.size, (1254, 1254))
                self.assertEqual(image.convert("RGBA").getchannel("A").getextrema(), (255, 255))

    def test_rename_examples_match_pinned_repository_hashes(self):
        for entry in CATALOG["states"]:
            originals = entry.get("original_frame_files", entry["frame_files"])
            self.assertEqual(len(originals), len(entry["sha256"]))
            for path, digest in zip(originals, entry["sha256"]):
                self.assertEqual(hashlib.sha256((EXAMPLES / path).read_bytes()).hexdigest(), digest)
            if entry.get("source_kind") == "repaired":
                self.assertEqual(len(entry["frame_files"]), len(entry["derived_sha256"]))
                for path, digest in zip(entry["frame_files"], entry["derived_sha256"]):
                    self.assertEqual(hashlib.sha256((EXAMPLES / path).read_bytes()).hexdigest(), digest)

    def test_auto_cutout_star_removes_corners_and_keeps_subject(self):
        path = self.green()
        job = self.post([path], {"mode": "cutout", "size": 0}).json
        result = self.output(job)
        original = Image.open(path).convert("RGBA")
        self.assertEqual(result.size, original.size)
        for point in [(0, 0), (1253, 0), (0, 1253), (1253, 1253), (50, 50)]:
            self.assertEqual(result.getpixel(point)[3], 0)
        for point in [(627, 627), (600, 600), (500, 600)]:
            self.assertEqual(result.getpixel(point), original.getpixel(point))
        histogram = result.getchannel("A").histogram()
        self.assertGreater(histogram[0] / (1254 * 1254), .4)

    def test_manual_cutout_star_keeps_dimensions_and_foreground(self):
        path = self.green()
        original = Image.open(path).convert("RGBA")
        color = "#%02x%02x%02x" % original.getpixel((0, 0))[:3]
        job = self.post([path], {"mode": "cutout", "auto_color": False, "color": color, "size": 0}).json
        result = self.output(job)
        self.assertEqual(result.getpixel((0, 0))[3], 0)
        self.assertEqual(result.getpixel((627, 627)), original.getpixel((627, 627)))

    def test_auto_cutout_portrait_keeps_face_and_garment(self):
        path = self.green("comfort")
        job = self.post([path], {"mode": "cutout", "size": 0}).json
        result = self.output(job)
        original = Image.open(path).convert("RGBA")
        self.assertEqual(result.getpixel((0, 0))[3], 0)
        for point in [(627, 180), (627, 600), (500, 600)]:
            self.assertEqual(result.getpixel(point), original.getpixel(point))
        self.assertNotEqual(result.getchannel("A").getextrema(), (0, 0))

    def test_batch_cutout_outputs_both_real_originals(self):
        response = self.post([self.green(), self.green("comfort")], {"mode": "cutout", "size": 0, "prefix": "cutout"})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json["frame_count"], 2)
        for index in [0, 1]:
            self.assertEqual(self.output(response.json, index).getpixel((0, 0))[3], 0)

    def test_tolerance_is_monotonic_on_real_green_input(self):
        with Image.open(self.green()) as image:
            original = image.convert("RGBA")
        counts = []
        for tolerance in [0, 18, 40]:
            result = remove_color(original, server.validate_options({"tolerance": tolerance}))
            counts.append(result.getchannel("A").histogram()[0])
        self.assertEqual(counts, sorted(counts))
        self.assertGreater(counts[-1], counts[0])

    def test_feather_produces_partial_alpha_without_changing_rgb(self):
        image = Image.new("RGBA", (3, 1), (0, 255, 0, 255))
        image.putpixel((1, 0), (5, 255, 0, 255))
        image.putpixel((2, 0), (255, 0, 0, 255))
        options = server.validate_options({"auto_color": False, "color": "#00ff00", "tolerance": 0, "feather": 10})
        result = remove_color(image, options)
        self.assertTrue(0 < result.getpixel((1, 0))[3] < 255)
        self.assertEqual(result.getpixel((1, 0))[:3], image.getpixel((1, 0))[:3])
        self.assertEqual(result.getpixel((2, 0))[3], 255)

    def test_rename_six_original_frames_preserves_every_pixel(self):
        paths = self.originals()
        job = self.post(paths, {"mode": "rename", "prefix": "asset"}).json
        self.assertEqual([group["frames"][0]["filename"] for group in job["groups"]], [f"asset_{i:04d}.png" for i in range(1, 7)])
        for index, path in enumerate(paths):
            with Image.open(path) as original:
                self.assertEqual(self.output(job, index).tobytes(), original.convert("RGBA").tobytes())
        with zipfile.ZipFile(io.BytesIO(self.get(job["zip_url"]).data)) as archive:
            self.assertEqual(len([name for name in archive.namelist() if name.endswith(".png")]), 6)
            self.assertIsNone(archive.testzip())

    def test_rename_ignores_inactive_canvas_and_crop_settings(self):
        response = self.post(self.originals()[:2], {
            "mode": "rename", "prefix": "asset", "frames": 0, "bounds": [10, 5],
            "size": 1, "padding": 128, "layout": "invalid", "color": "invalid",
        })
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json["options"]["bounds"], [])
        self.assertEqual(self.output(response.json).size, (512, 512))

    def test_cutout_ignores_inactive_split_settings(self):
        response = self.post([self.green()], {"mode": "cutout", "frames": 0, "bounds": [9, 2], "layout": "invalid"})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json["options"]["bounds"], [])

    def test_single_frame_split_and_empty_upload(self):
        self.assertEqual(self.post(self.originals()[:1], {"mode": "split", "frames": 1}).json["frame_count"], 1)
        self.assertEqual(self.post([], {}).status_code, 400)

    def test_twelve_files_allowed_thirteen_rejected(self):
        path = self.originals()[0]
        allowed = self.post([path] * 12, {"mode": "rename"})
        self.assertEqual(allowed.status_code, 201)
        self.assertEqual(allowed.json["frame_count"], 12)
        self.assertEqual(self.post([path] * 13, {"mode": "rename"}).status_code, 400)

    def test_nonfinite_boolean_and_null_numeric_values_are_client_errors(self):
        for value in [None, True, float("inf"), float("nan"), [], 2.5, "abc"]:
            with self.subTest(value=value):
                self.assertEqual(self.post(self.originals()[:1], {"frames": value}).status_code, 400)

    def test_busy_server_returns_429(self):
        server.PROCESSING_SLOTS.acquire()
        server.PROCESSING_SLOTS.acquire()
        try:
            self.assertEqual(self.post(self.originals()[:1], {}).status_code, 429)
        finally:
            server.PROCESSING_SLOTS.release()
            server.PROCESSING_SLOTS.release()

    def test_upload_body_limit_returns_413(self):
        response = self.client.post("/api/process", data={"options": "{}"},
                                    environ_overrides={"CONTENT_LENGTH": str(41 * 1024 * 1024)})
        self.responses.append(response)
        self.assertEqual(response.status_code, 413)
        self.assertIn("40 MB", response.json["error"])

    def test_oversized_png_dimensions_rejected_before_decode(self):
        import struct
        import zlib
        def chunk(kind, content):
            return struct.pack(">I", len(content)) + kind + content + struct.pack(">I", zlib.crc32(kind + content))
        ihdr = struct.pack(">IIBBBBB", 5000, 5000, 8, 6, 0, 0, 0)
        content = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"")) + chunk(b"IEND", b"")
        response = self.client.post("/api/process", data={"files": (io.BytesIO(content), "oversize.png")})
        self.responses.append(response)
        self.assertEqual(response.status_code, 400)
        self.assertIn("总像素", response.json["error"])

    def test_prefix_validation_and_empty_result_warning(self):
        for prefix in ["", "../escape", "a/b", "中文", "a" * 49]:
            self.assertEqual(self.post(self.originals()[:1], {"mode": "rename", "prefix": prefix}).status_code, 400)
        job = self.post([self.green()], {"mode": "cutout", "tolerance": 100}).json
        self.assertTrue(job["warnings"])
        self.assertEqual(self.output(job).getchannel("A").getextrema(), (0, 0))


if __name__ == "__main__":
    unittest.main()
