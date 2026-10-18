import io
import json
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw
import app as server
from tools.image_pipeline import fit_frames, remove_color, split_image


def png(image):
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    buffer.seek(0)
    return buffer


class PipelineTests(unittest.TestCase):
    def options(self, **changes):
        return server.validate_options(changes)

    def test_non_divisible_strip_keeps_last_pixel(self):
        image = Image.new("RGBA", (10, 3))
        for x in range(10):
            for y in range(3):
                image.putpixel((x, y), (x * 20, 0, 0, 255))
        frames = split_image(image, self.options(frames=3))
        self.assertEqual([frame.width for frame in frames], [3, 3, 4])
        self.assertEqual(frames[-1].getpixel((3, 2)), image.getpixel((9, 2)))

    def test_vertical_and_grid_order(self):
        image = Image.new("RGBA", (6, 4))
        colors = [(255, 0, 0, 255), (0, 255, 0, 255), (0, 0, 255, 255), (255, 255, 0, 255), (0, 255, 255, 255), (255, 0, 255, 255)]
        draw = ImageDraw.Draw(image)
        for index, color in enumerate(colors):
            x, y = index % 3 * 2, index // 3 * 2
            draw.rectangle((x, y, x + 1, y + 1), fill=color)
        grid = split_image(image, self.options(layout="grid", rows=2, columns=3))
        self.assertEqual([frame.getpixel((0, 0)) for frame in grid], colors)
        vertical = split_image(image, self.options(layout="vertical", frames=2))
        self.assertEqual([frame.size for frame in vertical], [(6, 2), (6, 2)])
        self.assertEqual(vertical[1].getpixel((0, 0)), colors[3])

    def test_custom_crops_and_invalid_boundaries(self):
        image = Image.new("RGBA", (12, 2))
        frames = split_image(image, self.options(frames=3, bounds=[2, 9]))
        self.assertEqual([frame.width for frame in frames], [2, 7, 3])
        for bounds in [[9, 2], [2, 2], [0, 9], [2, 12], [2.5, 9], [True, 9]]:
            with self.subTest(bounds=bounds), self.assertRaises(ValueError):
                split_image(image, self.options(frames=3, bounds=bounds))

    def test_color_removal_preserves_original_alpha_and_foreground(self):
        image = Image.new("RGBA", (4, 4), (0, 255, 0, 255))
        image.putpixel((2, 2), (255, 0, 0, 128))
        image.putpixel((1, 1), (0, 0, 0, 0))
        result = remove_color(image, self.options(auto_color=False, color="#00ff00", tolerance=0, feather=0))
        self.assertEqual(result.getpixel((0, 0))[3], 0)
        self.assertEqual(result.getpixel((2, 2)), (255, 0, 0, 128))
        self.assertEqual(result.getpixel((1, 1))[3], 0)

    def test_auto_color_handles_tiny_and_transparent_images(self):
        image = Image.new("RGBA", (2, 2), (255, 255, 255, 255))
        self.assertEqual(remove_color(image, self.options()).getchannel("A").getextrema(), (0, 0))
        transparent = Image.new("RGBA", (1, 1))
        self.assertEqual(remove_color(transparent, self.options()).getpixel((0, 0)), (0, 0, 0, 0))

    def test_alignment_uses_one_scale_and_shared_baseline(self):
        images = []
        for height in [30, 15]:
            image = Image.new("RGBA", (50, 50))
            ImageDraw.Draw(image).rectangle((10, 10, 19, 9 + height), fill=(255, 0, 0, 255))
            images.append(image)
        frames = fit_frames(images, self.options(size=100, padding=10, ratio=80, align=True))
        boxes = [frame.getchannel("A").getbbox() for frame in frames]
        self.assertEqual(boxes[0][3], boxes[1][3])
        self.assertAlmostEqual((boxes[0][3] - boxes[0][1]) / (boxes[1][3] - boxes[1][1]), 2, delta=.15)
        self.assertEqual(frames[0].size, (100, 100))

    def test_empty_frame_and_original_size(self):
        image = Image.new("RGBA", (7, 9))
        self.assertIs(fit_frames([image], self.options(size=0))[0], image)
        self.assertEqual(fit_frames([image], self.options(size=256, align=True))[0].getchannel("A").getextrema(), (0, 0))
        self.assertEqual(fit_frames([image], self.options(size=0, trim=True))[0].size, (1, 1))


class ApiTests(unittest.TestCase):
    def setUp(self):
        Path(".runtime").mkdir(exist_ok=True)
        self.storage = tempfile.TemporaryDirectory(dir=".runtime", prefix="test-")
        self.previous_directory = server.DATA_DIR
        server.DATA_DIR = Path(self.storage.name).resolve()
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

    def get(self, url):
        response = self.client.get(url)
        self.responses.append(response)
        return response

    def process(self, image=None, options=None, multiple=None):
        if image is None:
            image = Image.new("RGBA", (18, 3), (255, 0, 0, 255))
        files = multiple or [(image, "example.png")]
        response = self.client.post("/api/process", data={"options": json.dumps(options or {"frames": 3, "size": 32, "padding": 2}), "files": [(png(value), name) for value, name in files]}, content_type="multipart/form-data")
        self.responses.append(response)
        return response

    def test_home_assets_and_health(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.get("/static/app.js").status_code, 200)
        self.assertEqual(self.client.get("/api/health").json["name"], "FrameMe")
        self.assertEqual(self.client.get("/editor").status_code, 200)

    def test_zip_png_sheet_and_job_metadata(self):
        response = self.process()
        self.assertEqual(response.status_code, 201)
        job = response.json
        self.assertEqual(job["frame_count"], 3)
        self.assertNotIn(str(server.DATA_DIR), response.get_data(as_text=True))
        self.assertEqual(self.client.get("/api/jobs/" + job["id"]).json["id"], job["id"])
        image = Image.open(io.BytesIO(self.get(job["groups"][0]["frames"][0]["url"]).data))
        self.assertEqual(image.size, (32, 32))
        self.assertEqual(image.mode, "RGBA")
        export = self.get(job["zip_url"])
        with zipfile.ZipFile(io.BytesIO(export.data)) as archive:
            self.assertEqual(set(archive.namelist()), {"frame_0001.png", "frame_0002.png", "frame_0003.png", "frames.json"})
            self.assertNotIn("source_0.png", archive.namelist())
        sheet = Image.open(io.BytesIO(self.get(job["sheet_url"]).data))
        self.assertEqual(sheet.size, (64, 64))

    def test_gif_has_loop_transparency_and_requested_duration(self):
        image = Image.new("RGBA", (24, 8))
        draw = ImageDraw.Draw(image)
        for index, color in enumerate(["red", "blue", "orange"]):
            draw.rectangle((index * 8 + 2, 2, index * 8 + 5, 5), fill=color)
        job = self.process(image, {"frames": 3, "size": 0}).json
        response = self.get(job["gif_url"] + "?fps=10")
        self.assertEqual(response.status_code, 200)
        gif = Image.open(io.BytesIO(response.data))
        self.assertEqual(gif.n_frames, 3)
        self.assertEqual(gif.info["loop"], 0)
        self.assertEqual(gif.info["duration"], 100)
        self.assertEqual(gif.convert("RGBA").getpixel((0, 0))[3], 0)

    def test_batch_files_have_unique_names_and_rename_is_sequential(self):
        first = Image.new("RGBA", (6, 3), "red")
        second = Image.new("RGBA", (6, 3), "blue")
        multiple = [(first, "same.png"), (second, "same.png")]
        job = self.process(multiple=multiple).json
        names = [frame["filename"] for group in job["groups"] for frame in group["frames"]]
        self.assertEqual(len(names), len(set(names)))
        renamed = self.process(options={"mode": "rename", "prefix": "asset", "size": 256, "remove_bg": True}, multiple=multiple).json
        self.assertEqual([group["frames"][0]["filename"] for group in renamed["groups"]], ["asset_0001.png", "asset_0002.png"])
        output = Image.open(io.BytesIO(self.get(renamed["groups"][0]["frames"][0]["url"]).data))
        self.assertEqual(output.size, (6, 3))
        self.assertEqual(output.getpixel((0, 0)), (255, 0, 0, 255))

    def test_two_jobs_do_not_overwrite_each_other(self):
        first = self.process(Image.new("RGBA", (18, 3), "red")).json
        second = self.process(Image.new("RGBA", (18, 3), "blue")).json
        self.assertNotEqual(first["id"], second["id"])
        for job, expected in [(first, (255, 0, 0, 255)), (second, (0, 0, 255, 255))]:
            output = Image.open(io.BytesIO(self.get(job["groups"][0]["frames"][0]["url"]).data))
            self.assertEqual(output.getpixel((16, 16)), expected)

    def test_validation_cleans_failed_jobs(self):
        for options in [{"prefix": "../../outside"}, {"frames": 129}, {"frames": 3, "bounds": [8, 2]}, {"size": 16, "padding": 16}, {"layout": "grid", "rows": 16, "columns": 8, "size": 1024}]:
            with self.subTest(options=options):
                image = Image.new("RGBA", (128, 32))
                self.assertEqual(self.process(image, options).status_code, 400)
                self.assertEqual(list(server.DATA_DIR.iterdir()) if server.DATA_DIR.exists() else [], [])

    def test_invalid_images_and_unsupported_formats(self):
        response = self.client.post("/api/process", data={"files": (io.BytesIO(b"not an image"), "a.png")})
        self.assertEqual(response.status_code, 400)
        buffer = io.BytesIO()
        Image.new("RGB", (2, 2)).save(buffer, "BMP")
        buffer.seek(0)
        self.assertEqual(self.client.post("/api/process", data={"files": (buffer, "a.bmp")}).status_code, 400)

    def test_paths_and_cross_origin_requests_are_rejected(self):
        self.assertEqual(self.client.get("/api/jobs/not-an-id").status_code, 404)
        job = self.process().json
        self.assertEqual(self.client.get("/api/jobs/" + job["id"] + "/frames/source_0.png").status_code, 404)
        self.assertEqual(self.client.get("/api/jobs/" + job["id"] + "/source/9").status_code, 404)
        self.assertEqual(self.client.post("/run", data={"skin_dir": "D:/outside"}).status_code, 404)
        self.assertEqual(self.client.post("/api/process", headers={"Origin": "https://other.example"}).status_code, 403)

    def test_old_results_stay_accessible_and_are_not_cleaned(self):
        job = self.process().json
        manifest_path = server.DATA_DIR / job["id"] / "manifest.json"
        import os
        old = time.time() - 365 * 86400
        os.utime(manifest_path, (old, old))
        self.assertEqual(self.client.get("/api/jobs/" + job["id"]).status_code, 200)
        server.cleanup_jobs()
        self.assertTrue(manifest_path.parent.exists())

    def test_export_argument_errors_are_json(self):
        job = self.process().json
        for suffix in ["?fps=0", "?fps=100", "?group=9", "?fps=abc"]:
            response = self.client.get(job["gif_url"] + suffix)
            self.assertEqual(response.status_code, 400)
            self.assertFalse(response.json["ok"])

    def test_folder_zip_uses_prefix_as_action_directory(self):
        job = self.process(options={"frames": 3, "prefix": "calm", "size": 0}).json
        response = self.get(job["folders_zip_url"])
        self.assertEqual(response.status_code, 200)
        with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
            self.assertEqual(set(archive.namelist()), {
                "calm/calm_0001.png", "calm/calm_0002.png", "calm/calm_0003.png", "frames.json"
            })
            self.assertIsNone(archive.testzip())

    def test_bytepet_examples_round_trip_without_pixel_changes(self):
        root = Path(__file__).resolve().parents[1] / "web/static/examples/bytepet"
        catalog = json.loads((root / "example.json").read_text(encoding="utf-8"))
        self.assertEqual({entry["key"] for entry in catalog["states"]}, {"calm", "happy", "run_right"})
        for entry in catalog["states"]:
            with self.subTest(state=entry["key"]):
                with Image.open(root / entry["strip"]) as source:
                    strip = source.copy()
                job = self.process(strip, {
                    "frames": entry["frames"], "size": 0, "prefix": entry["key"]
                }).json
                self.assertEqual(job["frame_count"], entry["frames"])
                with zipfile.ZipFile(io.BytesIO(self.get(job["folders_zip_url"]).data)) as archive:
                    for index in range(entry["frames"]):
                        filename = f"{entry['key']}/{entry['key']}_{index + 1:04d}.png"
                        output = Image.open(io.BytesIO(archive.read(filename)))
                        self.assertEqual(output.size, (512, 512))
                        self.assertEqual(output.mode, "RGBA")
                        expected = strip.crop((index * 512, 0, (index + 1) * 512, 512))
                        self.assertEqual(output.tobytes(), expected.tobytes())
                with Image.open(root / entry["thumbnail"]) as thumbnail:
                    self.assertEqual(strip.crop((0, 0, 512, 512)).tobytes(), thumbnail.tobytes())
                self.assertEqual(entry["fps"], 5 if entry["key"] == "run_right" else 4)


if __name__ == "__main__":
    unittest.main()
