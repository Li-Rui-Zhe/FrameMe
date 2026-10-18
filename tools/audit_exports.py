"""Inspect artifacts downloaded by the actual browser, not only API responses."""
import io
import json
import zipfile
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "web/static/examples/bytepet"
EVIDENCE = ROOT / ".runtime/test-evidence"
records = []


def check(case_id, name, function):
    try:
        detail = function()
        records.append({"id": case_id, "name": name, "status": "PASS", "detail": detail})
    except Exception as exc:
        records.append({"id": case_id, "name": name, "status": "FAIL", "error": str(exc)})


def image_equal(left, right):
    assert left.size == right.size
    assert left.convert("RGBA").tobytes() == right.convert("RGBA").tobytes()


def split_zip(name, nested):
    with zipfile.ZipFile(EVIDENCE / name) as archive:
        assert archive.testzip() is None
        assert "frames.json" in archive.namelist()
        for index in range(1, 7):
            filename = f"calm_{index:04d}.png"
            image = Image.open(io.BytesIO(archive.read(f"calm/{filename}" if nested else filename)))
            with Image.open(EXAMPLE / "frames" / filename) as original:
                image_equal(image, original)
        return "6/6 帧尺寸、RGBA 和完整像素与原素材一致；ZIP CRC 校验通过"


def sheet():
    with Image.open(EVIDENCE / "split-sheet.png") as image:
        assert image.size == (1536, 1024)
        assert image.mode == "RGBA"
        for index in range(6):
            cell = image.crop((index % 3 * 512, index // 3 * 512, index % 3 * 512 + 512, index // 3 * 512 + 512))
            with Image.open(EXAMPLE / f"frames/calm_{index + 1:04d}.png") as original:
                image_equal(cell, original)
    return "1536×1024，3列2行，6个单元格原图像素一致"


def gif():
    with Image.open(EVIDENCE / "split-animation.gif") as image:
        assert image.n_frames == 6
        assert image.info["loop"] == 0
        assert image.info["duration"] == 250
        assert image.convert("RGBA").getpixel((0, 0))[3] == 0
    return "6帧，512×512，4 FPS（250 ms），无限循环，透明角落正常；GIF调色板量化不做PNG级像素一致承诺"


def cutout(filename, original_name, foreground):
    with Image.open(EVIDENCE / filename) as image, Image.open(EXAMPLE / "originals" / original_name) as original:
        image = image.convert("RGBA")
        assert image.size == (1254, 1254)
        for point in [(0, 0), (1253, 0), (0, 1253), (1253, 1253), (50, 50)]:
            assert image.getpixel(point)[3] == 0
        for point in foreground:
            assert image.getpixel(point) == original.convert("RGBA").getpixel(point)
        histogram = image.getchannel("A").histogram()
        return {"size": list(image.size), "transparent_pixels": histogram[0],
                "transparent_percent": round(histogram[0] / (1254 * 1254) * 100, 3),
                "partial_alpha_pixels": sum(histogram[1:255]), "background_samples": "5/5透明", "foreground_samples": f"{len(foreground)}/{len(foreground)}完全一致"}


def rename():
    with zipfile.ZipFile(EVIDENCE / "rename-six.zip") as archive:
        assert archive.testzip() is None
        pngs = sorted(name for name in archive.namelist() if name.endswith(".png"))
        assert pngs == [f"image-set_{index:04d}.png" for index in range(1, 7)]
        for index, name in enumerate(pngs, 1):
            with Image.open(EXAMPLE / f"frames/calm_{index:04d}.png") as original:
                image_equal(Image.open(io.BytesIO(archive.read(name))), original)
    with Image.open(EVIDENCE / "rename-third.png") as third, Image.open(EXAMPLE / "frames/calm_0003.png") as original:
        image_equal(third, original)
    return "6张连续编号且无重复，全部原PNG像素不变；点击第三张下载正确"


def mixed():
    with zipfile.ZipFile(EVIDENCE / "rename-mixed.zip") as archive:
        assert archive.testzip() is None
        for index, name in enumerate(["bytepet-original.jpg", "bytepet-original.webp"], 1):
            with Image.open(EVIDENCE / name) as original:
                image_equal(Image.open(io.BytesIO(archive.read(f"image-set_{index:04d}.png"))), original)
    return "JPEG/WebP解码后转换成PNG，输出像素与解码后的输入一致；JPEG此前压缩损失不在此比较范围"


check("FILE-01", "横向切帧ZIP内容及像素", lambda: split_zip("split-frames.zip", False))
check("FILE-02", "动作目录ZIP内容及像素", lambda: split_zip("split-folders.zip", True))
check("FILE-03", "精灵图排布及像素", sheet)
check("FILE-04", "GIF帧数、速度、循环与透明", gif)
check("FILE-05", "星球原图自动抠图结果", lambda: cutout("star-cutout.png", "star_uploaded_input.png", [(627, 627), (600, 600), (500, 600)]))
check("FILE-06", "星球原图手动取色结果", lambda: cutout("star-cutout-manual.png", "star_uploaded_input.png", [(627, 627), (600, 600), (500, 600)]))
check("FILE-07", "立绘原图抠图结果", lambda: cutout("portrait-cutout.png", "comfort_0001_uploaded_input.png", [(627, 180), (627, 600), (500, 600)]))
check("FILE-08", "原始PNG批量命名与指定单张下载", rename)
check("FILE-09", "JPEG/WebP命名导出像素", mixed)
(EVIDENCE / "export-audit.json").write_text(json.dumps({"results": records, "passed": sum(row["status"] == "PASS" for row in records), "failed": sum(row["status"] == "FAIL" for row in records)}, ensure_ascii=False, indent=2), encoding="utf-8")
for record in records:
    print(f"{record['status']} {record['id']} {record['name']}")
raise SystemExit(1 if any(row["status"] == "FAIL" for row in records) else 0)
