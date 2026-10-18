"""Bundle untouched input materials for cutout and batch naming examples."""
import hashlib
import json
import shutil
from pathlib import Path

from tools.build_bytepet_example import CACHE, DESTINATION, ROOT, build


def build_tool_examples():
    catalog_path = DESTINATION / "example.json"
    if not catalog_path.exists():
        build()
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    for entry in catalog["states"]:
        if entry.get('source_kind') == 'repaired':
            # Derived frames were prepared separately; keep them and the untouched originals.
            continue
        entry["frame_files"] = []
        for path in entry["source_files"]:
            original = CACHE / path
            if not original.exists():
                from tools.build_bytepet_example import download
                download(path)
            relative = f"frames/{original.name}"
            target = DESTINATION / relative
            target.parent.mkdir(exist_ok=True)
            shutil.copyfile(original, target)
            entry["frame_files"].append(relative)
    catalog["cutout_states"] = []
    raw = ROOT / "assets/skins/rick_default/_generated_strips"
    for key, filename, label in [
        ("star", "star_uploaded_input.png", "星球图标 · 绿幕原图"),
        ("comfort", "comfort_0001_uploaded_input.png", "人物立绘 · 绿幕原图"),
    ]:
        source = raw / filename
        destination = DESTINATION / f"originals/{filename}"
        destination.parent.mkdir(exist_ok=True)
        shutil.copyfile(source, destination)
        catalog["cutout_states"].append({
            "key": key, "label": label, "file": f"originals/{filename}",
            "source": source.relative_to(ROOT).as_posix(),
            "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "width": 1254, "height": 1254, "tolerance": 18, "feather": 8,
        })
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Bundled original green-screen inputs and 16 untouched BytePet frames.")


if __name__ == "__main__":
    build_tool_examples()
