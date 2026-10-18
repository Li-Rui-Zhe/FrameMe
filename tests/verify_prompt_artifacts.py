"""Decode files downloaded by browser_prompts.cjs, after generating its fixtures."""
from pathlib import Path
from PIL import Image, ImageSequence
import io
import json
import zipfile

output = Path(__file__).resolve().parent.parent / '.runtime/prompt-evidence'
results = []
with Image.open(output / 'prompt-animation.gif') as image:
    assert image.format == 'GIF' and image.n_frames == 6
    assert image.size == (512, 512) and image.info['loop'] == 0
    assert all(frame.info['duration'] == 250 for frame in ImageSequence.Iterator(image))
results.append({'name': '长条流程导出的GIF为512px六帧、4FPS循环动画', 'status': 'PASS'})
for filename in ['prompt-frames.zip', 'independent-frames.zip']:
    with zipfile.ZipFile(output / filename) as archive:
        assert archive.testzip() is None
        names = [name for name in archive.namelist() if name.endswith('.png')]
        assert len(names) == 6
        for name in names:
            with Image.open(io.BytesIO(archive.read(name))) as image:
                image.load()
                assert image.format == 'PNG' and image.size == (512, 512)
                assert image.convert('RGBA').getpixel((0, 0))[3] == 0
                assert image.convert('RGBA').getchannel('A').getextrema() == (0, 255)
    results.append({'name': filename + ' 包含六张512px透明PNG且CRC正确', 'status': 'PASS'})
(output / 'artifact-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
print('PASS: 3 artifact checks')
