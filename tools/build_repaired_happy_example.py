"""Prepare a repaired sprite sheet with the workbench's normal split/fit pipeline.

Usage: python -m tools.build_repaired_happy_example --source path/to/ai-repaired.png
Original BytePet files and their source hashes stay untouched.
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

from PIL import Image
from tools.image_pipeline import fit_frames, split_image, remove_color

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'web/static/examples/bytepet'


def build(source):
    directory = DEST / 'curated/happy-v2'
    directory.mkdir(parents=True, exist_ok=True)
    if source.resolve() != (directory / 'repair-source.png').resolve():
        shutil.copyfile(source, directory / 'repair-source.png')
    with Image.open(source) as image:
        options = {'layout': 'horizontal', 'frames': 6, 'bounds': [],
                   'size': 512, 'padding': 24, 'ratio': 68, 'align': True, 'trim': True,
                   'auto_color': True, 'color': '#33ff00', 'tolerance': 50, 'feather': 32}
        # Use the same free chroma removal and frame fitting as the workbench.
        frames = fit_frames(split_image(remove_color(image, options), options), options)
    strip = Image.new('RGBA', (3072, 512))
    files, hashes = [], []
    for i, frame in enumerate(frames):
        target = directory / f'happy_{i+1:04d}.png'
        frame.save(target, optimize=True)
        files.append(target.relative_to(DEST).as_posix())
        hashes.append(hashlib.sha256(target.read_bytes()).hexdigest())
        strip.paste(frame, (512*i, 0))
    strip.save(directory / 'happy-strip.png', optimize=True)
    frames[0].save(directory / 'happy-thumbnail.png', optimize=True)
    gif_frames = []
    for frame in frames:
        palette = frame.convert('RGB').quantize(colors=255, dither=Image.Dither.NONE)
        palette.putpalette((palette.getpalette() + [0] * 768)[:765] + [0, 0, 0])
        palette.paste(255, mask=frame.getchannel('A').point(lambda a: 255 if a < 128 else 0))
        palette.info['transparency'] = 255
        gif_frames.append(palette)
    gif_frames[0].save(directory / 'happy-preview.gif', format='GIF', save_all=True,
                       append_images=gif_frames[1:], loop=0, duration=250,
                       transparency=255, disposal=2, optimize=False)
    path = DEST / 'example.json'
    catalog = json.loads(path.read_text(encoding='utf-8'))
    entry = next(row for row in catalog['states'] if row['key'] == 'happy')
    entry.setdefault('original_frame_files', entry['frame_files'])
    entry.setdefault('original_strip', entry['strip'])
    entry.setdefault('original_thumbnail', entry['thumbnail'])
    entry.update(frame_files=files, strip='curated/happy-v2/happy-strip.png',
                 thumbnail='curated/happy-v2/happy-thumbnail.png',
                 source_kind='repaired', derived_sha256=hashes,
                 source_note='基于 BytePet 开心动作的 AI 修补与重绘演示：补全天线顶端、整理轮廓与安全留白；原始素材另行保留。')
    path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Prepared 6 repaired frames, strip and thumbnail; original assets preserved.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    build(parser.parse_args().source)
