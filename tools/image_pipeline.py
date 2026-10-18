"""Pillow-only operations, independent from HTTP and storage."""
from __future__ import annotations

import math
from statistics import median
from PIL import Image, ImageChops, ImageColor


def remove_color(image, options):
    image = image.convert("RGBA")
    if options["auto_color"]:
        sample = image.copy()
        sample.thumbnail((128, 128))
        w, h = sample.size
        size = min(4, w, h)
        pixels = []
        sample_pixels = sample.load()
        for left, top in [(0, 0), (w - size, 0), (0, h - size), (w - size, h - size)]:
            for y in range(top, top + size):
                for x in range(left, left + size):
                    pixel = sample_pixels[x, y]
                    if pixel[3] > 128:
                        pixels.append(pixel)
        if not pixels:
            return image
        color = tuple(int(median(p[channel] for p in pixels)) for channel in range(3))
    else:
        color = ImageColor.getrgb(options["color"])
    difference = ImageChops.difference(image.convert("RGB"), Image.new("RGB", image.size, color))
    red, green, blue = difference.split()
    distance = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    threshold, feather = options["tolerance"] * 2.55, options["feather"]
    mask = distance.point([0 if value <= threshold else min(255, round((value - threshold) / feather * 255)) if feather else 255 for value in range(256)])
    result = image.copy()
    result.putalpha(ImageChops.multiply(image.getchannel("A"), mask))
    return result


def split_image(image, options):
    width, height = image.size
    if options["layout"] == "grid":
        rows, columns = options["rows"], options["columns"]
        if rows > height or columns > width:
            raise ValueError("网格数量不能超过图片的像素尺寸")
        return [image.crop((math.floor(col * width / columns), math.floor(row * height / rows), math.floor((col + 1) * width / columns), math.floor((row + 1) * height / rows))) for row in range(rows) for col in range(columns)]
    horizontal = options["layout"] == "horizontal"
    extent = width if horizontal else height
    count = options["frames"]
    if count > extent:
        raise ValueError("帧数不能超过图片的像素尺寸")
    custom = options["bounds"]
    if custom:
        if len(custom) != count - 1:
            raise ValueError("裁剪线数量需等于帧数减一")
        if any(isinstance(value, bool) or not isinstance(value, int) for value in custom):
            raise ValueError("裁剪线需为整数像素坐标")
        if custom != sorted(set(custom)) or any(not 0 < value < extent for value in custom):
            raise ValueError("裁剪线需递增且位于图片范围内")
        boundaries = [0, *custom, extent]
    else:
        boundaries = [math.floor(index * extent / count) for index in range(count + 1)]
    return [image.crop((boundaries[index], 0, boundaries[index + 1], height) if horizontal else (0, boundaries[index], width, boundaries[index + 1])) for index in range(count)]


def fit_frames(frames, options, reference_frames=None):
    """Use one scale per sequence so pose changes keep their relative size."""
    # Retouch restoration uses original pixels with the processed image's exact
    # crop and placement, including trim/alignment. Never infer a second layout.
    drawing_frames = frames if reference_frames is None else reference_frames
    if len(drawing_frames) != len(frames) or any(a.size != b.size for a, b in zip(frames, drawing_frames)):
        raise ValueError("参考图尺寸与处理图不匹配")
    size, padding = options["size"], options["padding"]
    if not size and not options["trim"]:
        return drawing_frames
    boxes = [frame.getchannel("A").point(lambda value: 255 if value > 10 else 0).getbbox() for frame in frames]
    if not size:
        return [frame.crop(box) if box else Image.new("RGBA", (1, 1)) for frame, box in zip(drawing_frames, boxes)]
    align = options["align"] or options["trim"]
    if align:
        max_width = max(box[2] - box[0] if box else 1 for box in boxes)
        max_height = max(box[3] - box[1] if box else 1 for box in boxes)
        scale = min((size - padding * 2) / max_width, min(size - padding * 2, size * options["ratio"] / 100) / max_height)
    else:
        scale = min((size - padding * 2) / max(frame.width for frame in frames), (size - padding * 2) / max(frame.height for frame in frames))
    results = []
    for frame, box in zip(drawing_frames, boxes):
        canvas = Image.new("RGBA", (size, size))
        if align and not box:
            results.append(canvas)
            continue
        subject = frame.crop(box) if align else frame
        target = subject.resize((max(1, round(subject.width * scale)), max(1, round(subject.height * scale))), Image.Resampling.LANCZOS)
        x = (size - target.width) // 2
        y = size - padding - target.height if align else (size - target.height) // 2
        canvas.alpha_composite(target, (x, y))
        results.append(canvas)
    return results
