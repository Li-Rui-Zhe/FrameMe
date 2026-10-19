"""Pillow-only operations, independent from HTTP and storage."""
from __future__ import annotations

import math
from statistics import median
from PIL import Image, ImageChops, ImageColor, ImageDraw, ImageFilter


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
    # Flood only background connected to the image border. Matching colours
    # inside clothing/eyes are not evidence that those pixels are background.
    # Cap the threshold so raising tolerance cannot erase every colour.
    threshold, feather = min(options["tolerance"] * 2.55, 160), options["feather"]
    candidate = distance.point([255 if value <= threshold else 0 for value in range(256)])
    candidate = ImageChops.lighter(candidate, image.getchannel("A").point(lambda a: 255 if a == 0 else 0))
    padded = Image.new("L", (image.width + 2, image.height + 2), 255)
    padded.paste(candidate, (1, 1))
    ImageDraw.floodfill(padded, (0, 0), 128)
    background = padded.crop((1, 1, image.width + 1, image.height + 1)).point(lambda v: 255 if v == 128 else 0)
    mask = ImageChops.invert(background)
    result = image.copy()
    # Estimate the edge mixture from nearby foreground, then unmix the key
    # colour instead of merely making a green/blue fringe more transparent.
    # Restrict this to a narrow outer band; opaque interior pixels stay exact.
    if feather:
        band = ImageChops.subtract(background.filter(ImageFilter.MaxFilter(5)), background)
        local_distance = distance.filter(ImageFilter.MaxFilter(7))
        source, dst, alpha = image.load(), result.load(), mask.load()
        dist, nearby = distance.load(), local_distance.load()
        bounds = band.getbbox()
        if bounds:
            edge = band.load()
            for y in range(bounds[1], bounds[3]):
                for x in range(bounds[0], bounds[2]):
                    if not edge[x, y]:
                        continue
                    d, peak = dist[x, y], nearby[x, y]
                    if peak <= threshold or d >= peak:
                        continue
                    opacity = max(0.01, min(1.0, d / peak))
                    # Feather controls strength, independently from tolerance.
                    opacity = 1 - (1 - opacity) * min(1, feather / 8)
                    pixel = source[x, y]
                    dst[x, y] = tuple(max(0, min(255, round((pixel[c] - color[c] * (1 - opacity)) / opacity))) for c in range(3)) + (pixel[3],)
                    alpha[x, y] = round(opacity * 255)
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
    if not size and not options["trim"] and not options["align"]:
        return drawing_frames
    boxes = [frame.getchannel("A").point(lambda value: 255 if value > 10 else 0).getbbox() for frame in frames]
    if not size and options["align"]:
        results = []
        for frame, box in zip(drawing_frames, boxes):
            canvas = Image.new("RGBA", frame.size)
            if box:
                subject = frame.crop(box)
                canvas.alpha_composite(subject, ((frame.width - subject.width) // 2, (frame.height - subject.height) // 2))
            results.append(canvas)
        return results
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
        y = (size - target.height) // 2
        canvas.alpha_composite(target, (x, y))
        results.append(canvas)
    return results
