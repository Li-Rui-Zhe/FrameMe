import io
import json
import tempfile
import re
import unittest
import zipfile
from pathlib import Path
from PIL import Image
import app as server


class SessionIsolationTests(unittest.TestCase):
    def setUp(self):
        self.storage = tempfile.TemporaryDirectory(dir=server.BASE_DIR / ".runtime", prefix="test-session-")
        self.previous_directory = server.DATA_DIR
        server.DATA_DIR = Path(self.storage.name)
        self.a = server.app.test_client()
        self.b = server.app.test_client()
        self.responses = []
        buffer = io.BytesIO()
        Image.new("RGBA", (12, 4), "orange").save(buffer, "PNG")
        buffer.seek(0)
        response = self.a.post("/api/process", data={"files": (buffer, "source.png"), "options": json.dumps({"frames": 3})})
        self.responses.append(response)
        self.assertEqual(response.status_code, 201)
        self.job = response.json
        self.b.get("/")

    def tearDown(self):
        for response in self.responses:
            response.close()
            stream = response.request.environ.get("wsgi.input")
            if stream:
                stream.close()
        server.DATA_DIR = self.previous_directory
        self.storage.cleanup()

    def get(self, client, url):
        response = client.get(url)
        self.responses.append(response)
        return response

    def test_metadata_is_owned_by_browser_session(self):
        url = "/api/jobs/" + self.job["id"]
        self.assertEqual(self.get(self.a, url).status_code, 200)
        self.assertEqual(self.get(self.b, url).status_code, 404)

    def test_original_and_frames_are_not_readable_by_other_session(self):
        group = self.job["groups"][0]
        for url in [group["source_url"], group["frames"][0]["url"], group["frames"][0]["url"] + "?download=1"]:
            self.assertEqual(self.get(self.a, url).status_code, 200)
            self.assertEqual(self.get(self.b, url).status_code, 404)

    def test_all_exports_check_session_ownership(self):
        for kind in ["zip", "folders", "sheet", "gif"]:
            url = "/api/jobs/" + self.job["id"] + "/export/" + kind
            self.assertEqual(self.get(self.a, url).status_code, 200)
            self.assertEqual(self.get(self.b, url).status_code, 404)

    def test_cookie_has_httponly_and_samesite(self):
        client = server.app.test_client()
        response = self.get(client, "/")
        cookie = response.headers.get("Set-Cookie", "")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)
        self.assertEqual(self.get(client, "/static/examples/bytepet/example.json").status_code, 200)

    def test_signing_key_is_stable_across_loads(self):
        self.assertEqual(server.session_secret(), server.session_secret())
        self.assertTrue(server.app.secret_key)

    def test_draft_scope_is_stable_and_unique_to_browser_identity(self):
        def scope(client):
            response = self.get(client, "/")
            return re.search(rb'name="framelab-workspace-scope" content="([a-f0-9]{64})"', response.data).group(1)
        first = scope(self.a)
        self.assertEqual(first, scope(self.a))
        self.assertNotEqual(first, scope(self.b))
        self.a.delete_cookie("framelab_session")
        self.assertNotEqual(first, scope(self.a))

    def test_workspace_html_is_not_cached_across_browser_identities(self):
        response = self.get(self.a, "/")
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_owner_is_not_exposed_in_metadata_or_zip(self):
        self.assertNotIn("owner", self.job)
        with zipfile.ZipFile(io.BytesIO(self.get(self.a, self.job["zip_url"]).data)) as archive:
            self.assertNotIn("owner", json.loads(archive.read("frames.json")))

    def test_removing_cookie_revokes_access_to_previous_job(self):
        self.a.delete_cookie("framelab_session")
        self.assertEqual(self.get(self.a, "/api/jobs/" + self.job["id"]).status_code, 404)

    def test_old_unowned_jobs_cannot_be_claimed(self):
        path = server.DATA_DIR / self.job["id"] / "manifest.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data.pop("owner")
        path.write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(self.get(self.a, "/api/jobs/" + self.job["id"]).status_code, 404)


if __name__ == "__main__":
    unittest.main()
