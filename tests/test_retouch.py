import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw
import app as server
from tools.image_pipeline import fit_frames, remove_color


def encoded(image, format='PNG'):
    data = io.BytesIO()
    image.save(data, format)
    data.seek(0)
    return data


class RetouchTests(unittest.TestCase):
    def setUp(self):
        self.storage = tempfile.TemporaryDirectory(dir='.runtime', prefix='retouch-test-')
        self.previous = server.DATA_DIR
        server.DATA_DIR = Path(self.storage.name)
        self.client = server.app.test_client()
        self.responses = []
        self.source = Image.new('RGBA', (64, 40), (0, 255, 0, 255))
        ImageDraw.Draw(self.source).rectangle((16, 10, 47, 29), fill=(230, 30, 20, 255))
        self.source.putpixel((30, 20), (230, 30, 20, 128))

    def tearDown(self):
        for response in self.responses:
            response.close()
        server.DATA_DIR = self.previous
        self.storage.cleanup()

    def get(self, url, client=None):
        result = (client or self.client).get(url)
        self.responses.append(result)
        return result

    def process(self, **options):
        options = dict({'mode': 'cutout', 'size': 0, 'auto_color': False, 'color': '#00ff00', 'tolerance': 0, 'feather': 0}, **options)
        result = self.client.post('/api/process', data={'options': json.dumps(options), 'files': (encoded(self.source), 'original.png')})
        self.responses.append(result)
        self.assertEqual(result.status_code, 201)
        return result.json

    def edit(self, job, image=None, client=None, **fields):
        result = (client or self.client).post('/api/jobs/' + job['id'] + '/retouch', data={'image': (encoded(image or self.source), 'edit.png'), **fields})
        self.responses.append(result)
        return result

    def image(self, url):
        return Image.open(io.BytesIO(self.get(url).data)).convert('RGBA')

    def test_saved_revision_and_exports_use_edited_pixels(self):
        job = self.process()
        url = job['groups'][0]['frames'][0]['url']
        before = self.image(url)
        edited = before.copy()
        edited.putpixel((20, 15), (0, 0, 0, 0))
        revision = self.edit(job, edited)
        self.assertEqual(revision.status_code, 201)
        new = revision.json
        self.assertNotEqual(new['id'], job['id'])
        self.assertTrue(new['retouched'])
        self.assertEqual(self.image(url).getpixel((20, 15))[3], 255)
        self.assertEqual(self.image(new['groups'][0]['frames'][0]['url']).getpixel((20, 15))[3], 0)
        self.assertEqual(self.image(new['sheet_url']).getpixel((20, 15))[3], 0)
        for kind in ['zip_url', 'folders_zip_url']:
            with zipfile.ZipFile(io.BytesIO(self.get(new[kind]).data)) as archive:
                filename = next(name for name in archive.namelist() if name.endswith('.png'))
                saved = Image.open(io.BytesIO(archive.read(filename))).convert('RGBA')
                self.assertEqual(saved.getpixel((20, 15))[3], 0)
        gif = Image.open(io.BytesIO(self.get(new['gif_url']).data)).convert('RGBA')
        self.assertEqual(gif.getpixel((20, 15))[3], 0)
        self.assertTrue(self.get('/api/jobs/' + new['id']).json['retouched'])

    def test_restore_reference_preserves_rgba_and_dimensions(self):
        job = self.process()
        reference = self.image('/api/jobs/' + job['id'] + '/retouch-base/0')
        self.assertEqual(reference.tobytes(), self.source.tobytes())
        self.assertEqual(reference.getpixel((30, 20))[3], 128)
        self.assertEqual(self.image(job['groups'][0]['frames'][0]['url']).getpixel((0, 0))[3], 0)

    def test_reference_uses_processed_crop_and_alignment(self):
        for changes in [dict(trim=True), dict(size=128, padding=4, align=True), dict(size=128, trim=True, padding=4)]:
            with self.subTest(changes=changes):
                options = server.validate_options(dict(mode='cutout', color='#00ff00', auto_color=False, tolerance=0, feather=0, **changes))
                processed = remove_color(self.source, options)
                result = fit_frames([processed], options)[0]
                original = fit_frames([processed], options, reference_frames=[self.source])[0]
                self.assertEqual(result.size, original.size)
                # Red subject lands at exactly the same coordinates in both.
                for point in [(result.width // 2, result.height // 2), (result.width // 2, result.height - 6)]:
                    if result.getpixel(point)[3] > 250:
                        self.assertEqual(result.getpixel(point), original.getpixel(point))

    def test_size_and_format_rejected_without_creating_job(self):
        job = self.process()
        for image in [Image.new('RGBA', (10, 10)), Image.new('RGBA', (65, 40))]:
            self.assertEqual(self.edit(job, image).status_code, 400)
        result = self.client.post('/api/jobs/' + job['id'] + '/retouch', data={'image': (encoded(self.source.convert('RGB'), 'JPEG'), 'image.jpg')})
        self.assertEqual(result.status_code, 400)
        self.assertEqual(len(list(server.DATA_DIR.iterdir())), 1)

    def test_missing_corrupt_group_and_other_tool_rejected(self):
        job = self.process()
        endpoint = '/api/jobs/' + job['id'] + '/retouch'
        self.assertEqual(self.client.post(endpoint).status_code, 400)
        self.assertEqual(self.client.post(endpoint, data={'image': (io.BytesIO(b'broken'), 'broken.png')}).status_code, 400)
        for group in ['1', '-1', '0.5', '../other']:
            self.assertEqual(self.edit(job, group=group).status_code, 400)
        other = self.client.post('/api/process', data={'options': json.dumps({'mode': 'rename'}), 'files': (encoded(self.source), 'one.png')}).json
        self.assertEqual(self.edit(other).status_code, 400)
        self.assertEqual(self.get('/api/jobs/' + other['id'] + '/retouch-base/0').status_code, 404)

    def test_foreign_session_cannot_read_or_change_result(self):
        job = self.process()
        stranger = server.app.test_client()
        stranger.get('/')
        self.assertEqual(self.edit(job, client=stranger).status_code, 404)
        self.assertEqual(self.get('/api/jobs/' + job['id'] + '/retouch-base/0', stranger).status_code, 404)
        self.assertEqual(len(list(server.DATA_DIR.iterdir())), 1)

    def test_multi_image_edit_keeps_other_group_and_source(self):
        job = self.client.post('/api/process', data={'options': json.dumps({'mode': 'cutout'}), 'files': [(encoded(self.source), 'one.png'), (encoded(self.source), 'two.png')]}).json
        second = self.image(job['groups'][1]['frames'][0]['url'])
        edited = Image.new('RGBA', self.source.size)
        new = self.edit(job, edited, group='0').json
        self.assertEqual(self.image(new['groups'][1]['frames'][0]['url']).tobytes(), second.tobytes())
        self.assertEqual(self.image(new['groups'][0]['frames'][0]['url']).getchannel('A').getextrema(), (0, 0))
        self.assertEqual(self.image(new['groups'][0]['source_url']).tobytes(), self.source.tobytes())

    def test_cross_origin_edit_is_rejected(self):
        job = self.process()
        result = self.client.post('/api/jobs/' + job['id'] + '/retouch', headers={'Origin': 'https://unrelated.example'})
        self.assertEqual(result.status_code, 403)

    def test_reference_endpoint_matches_transformed_coordinates(self):
        for options in [dict(trim=True), dict(size=128, padding=4, align=True), dict(size=128, padding=4)]:
            with self.subTest(options=options):
                job = self.process(**options)
                processed = remove_color(self.source, job['options'])
                expected = fit_frames([processed], job['options'], reference_frames=[self.source])[0]
                actual = self.image('/api/jobs/' + job['id'] + '/retouch-base/0')
                self.assertEqual(actual.tobytes(), expected.tobytes())
                self.assertEqual(actual.size, self.image(job['groups'][0]['frames'][0]['url']).size)

    def test_processing_capacity_is_enforced_and_recovers(self):
        job = self.process()
        server.PROCESSING_SLOTS.acquire()
        server.PROCESSING_SLOTS.acquire()
        try:
            self.assertEqual(self.edit(job).status_code, 429)
        finally:
            server.PROCESSING_SLOTS.release()
            server.PROCESSING_SLOTS.release()
        self.assertEqual(self.edit(job).status_code, 201)

    def test_root_opens_workbench_without_introduction(self):
        home = self.get('/').get_data(as_text=True)
        editor = self.get('/editor').get_data(as_text=True)
        self.assertEqual(home, editor)
        self.assertIn('id="preview-canvas"', home)
        self.assertNotIn('landing.js', home)
        self.assertNotIn('id="welcome-upload"', home)
        self.assertNotIn('id="editor-home"', editor)
        self.assertIn('id="retouch-dialog"', editor)
        self.assertIn('/static/retouch.js', editor)

    def test_root_tool_link_opens_workbench(self):
        result = self.get('/?tool=cutout')
        self.assertEqual(result.status_code, 200)
        self.assertIn('id="settings-form"', result.get_data(as_text=True))


if __name__ == '__main__':
    unittest.main()
