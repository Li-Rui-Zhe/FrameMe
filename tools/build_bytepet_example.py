"""Rebuild the bundled BytePet example from a pinned public commit."""
from __future__ import annotations

import hashlib
import io
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
COMMIT = "8433f2d754f19df5bbcf0833a9271479d86e3754"
REPOSITORY = "https://github.com/Li-Rui-Zhe/BytePet"
RAW = f"https://raw.githubusercontent.com/Li-Rui-Zhe/BytePet/{COMMIT}/"
DESTINATION = ROOT / "web" / "static" / "examples" / "bytepet"
CACHE = ROOT / ".runtime" / "references" / "bytepet-files"
SELECTED = {"calm": "平静待机", "happy": "开心", "run_right": "向右跑"}


def download(path):
    target = CACHE / path
    if target.exists():
        return target.read_bytes()
    request = Request(RAW + path, headers={"User-Agent": "FrameMe-Example-Builder"})
    with urlopen(request, timeout=40) as response:
        content = response.read()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    return content


def build():
    DESTINATION.mkdir(parents=True, exist_ok=True)
    existing_path = DESTINATION / "example.json"
    existing = json.loads(existing_path.read_text(encoding="utf-8")) if existing_path.exists() else {}
    config = json.loads(download("src/config/animationStates.generated.json"))
    states = [state for state in config["states"] if state["key"] in SELECTED]
    if len(states) != len(SELECTED):
        raise ValueError("The pinned BytePet commit is missing example definitions")
    metadata = {"project": "BytePet", "repository": REPOSITORY, "commit": COMMIT, "license": "LICENSE.txt", "states": []}
    metadata["cutout_states"] = existing.get("cutout_states", [])
    for state in states:
        key = state["key"]
        paths = [f"public/assets/skins/rick_default/{key}/{key}_{index:04d}.png" for index in range(1, state["frames"] + 1)]
        with ThreadPoolExecutor(max_workers=4) as pool:
            contents = list(pool.map(download, paths))
        frames = []
        for content in contents:
            with Image.open(io.BytesIO(content)) as image:
                if image.size != (512, 512) or image.mode != "RGBA":
                    raise ValueError(f"Unexpected dimensions or alpha mode for {key}")
                frames.append(image.copy())
        strip = Image.new("RGBA", (512 * len(frames), 512))
        for index, frame in enumerate(frames):
            # Preserve RGB values in transparent pixels as well as visible colors.
            strip.paste(frame, (index * 512, 0))
        strip_name = f"{key}-strip.png"
        strip.save(DESTINATION / strip_name, optimize=True)
        (DESTINATION / f"{key}-thumbnail.png").write_bytes(contents[0])
        (DESTINATION / "frames").mkdir(exist_ok=True)
        frame_files = []
        for path, content in zip(paths, contents):
            relative = "frames/" + Path(path).name
            (DESTINATION / relative).write_bytes(content)
            frame_files.append(relative)
        metadata["states"].append({
            "key": key, "label": SELECTED[key], "frames": len(frames), "fps": state["fps"],
            "width": 512, "height": 512, "strip": strip_name,
            "thumbnail": f"{key}-thumbnail.png", "source_files": paths,
            "sha256": [hashlib.sha256(content).hexdigest() for content in contents],
            "frame_files": frame_files,
        })
        previous = next((item for item in existing.get('states', []) if item['key'] == key), {})
        if previous.get('source_kind') == 'repaired':
            for field in ['strip', 'thumbnail', 'frame_files', 'source_kind', 'source_note',
                          'derived_sha256', 'original_strip', 'original_thumbnail', 'original_frame_files']:
                metadata['states'][-1][field] = previous[field]
        print(f"Built {key}: {len(frames)} RGBA frames, {state['fps']} FPS", flush=True)
    (DESTINATION / "LICENSE.txt").write_bytes(download("LICENSE"))
    (DESTINATION / "example.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    for path in ["src/systems/skin/skinValidator.ts", "src/systems/animation/frameResolver.ts", "src-tauri/src/resources/mod.rs"]:
        download(path)
    print(f"Example source: {REPOSITORY}/tree/{COMMIT}", flush=True)


if __name__ == "__main__":
    build()
