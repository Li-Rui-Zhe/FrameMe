from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw


# ---------------------------------------------------------------------------
# Color utilities
# ---------------------------------------------------------------------------

def rgb_to_hsv(r, g, b):
    """Convert RGB to HSV. Returns (h: 0-360, s: 0-1, v: 0-1)."""
    r, g, b = r / 255.0, g / 255.0, b / 255.0
    max_c = max(r, g, b)
    min_c = min(r, g, b)
    diff = max_c - min_c

    if diff == 0:
        h = 0
    elif max_c == r:
        h = 60 * (((g - b) / diff) % 6)
    elif max_c == g:
        h = 60 * (((b - r) / diff) + 2)
    else:
        h = 60 * (((r - g) / diff) + 4)

    s = 0 if max_c == 0 else diff / max_c
    v = max_c
    return h, s, v



# ---------------------------------------------------------------------------
# Green screen removal — original (matches #33ff00)
# ---------------------------------------------------------------------------

def _is_green_hsv(h, s, v, hue_min=50, hue_max=185, sat_min=0.15, val_min=0.2):
    """Check if a pixel is green using HSV color space.

    Green hue range is roughly 60°-180°.  We extend slightly to catch
    yellow-green and cyan-green variants common in green screens.

    Args:
        h: Hue (0-360)
        s: Saturation (0-1)
        v: Value/Brightness (0-1)
        hue_min: Lower hue bound (default 50°, catches yellow-green)
        hue_max: Upper hue bound (default 185°, catches cyan-green)
        sat_min: Minimum saturation (filters out grays/whites)
        val_min: Minimum brightness (filters out blacks)
    """
    return hue_min <= h <= hue_max and s >= sat_min and v >= val_min


def _green_strength(h, s, v, hue_center=120, hue_min=50, hue_max=185):
    """Return 0-1 indicating how strongly green a pixel is.

    1.0 = pure green (hue=120, high saturation)
    0.0 = not green at all
    Used for edge feathering and spill removal.
    """
    if not (hue_min <= h <= hue_max):
        return 0.0
    # Hue distance from pure green (120°), normalized to 0-1
    hue_dist = abs(h - hue_center) / max(hue_center - hue_min, hue_max - hue_center)
    hue_score = max(0, 1 - hue_dist)
    # Saturation contributes: more saturated = more green
    sat_score = min(1, s / 0.5)
    return hue_score * sat_score


def remove_green_background(img: Image.Image, tolerance: int = 30) -> Image.Image:
    """Remove green background using HSV color space detection.

    HSV-based detection is much more robust than RGB because:
    - Hue (H) identifies "green" regardless of brightness/saturation
    - Saturation (S) separates green from gray/white/black
    - Value (V) ignores very dark pixels

    Tolerance controls the hue range width (±degrees around pure green).

    Args:
        img: Input RGBA image.
        tolerance: 0-100, controls how wide the green hue range is.
            0 = very narrow (only pure green ~120°)
            100 = very wide (50°-235°, catches teal/yellow-green)
    """
    img = img.convert("RGBA")
    pixels = list(img.getdata())
    width, height = img.size

    # Map tolerance (0-100) to hue range expansion
    # tolerance=30 → hue 65°-175° (default, good for most green screens)
    # tolerance=0  → hue 105°-135° (very narrow, only pure green)
    # tolerance=100 → hue 30°-210° (very wide, catches everything greenish)
    hue_center = 120
    hue_half_range = 15 + tolerance * 0.85  # 15° to 100°
    hue_min = max(0, hue_center - hue_half_range)
    hue_max = min(270, hue_center + hue_half_range)
    sat_min = max(0.05, 0.2 - tolerance * 0.0015)  # 0.2 → 0.05
    val_min = 0.15

    # Pre-compute: classify each pixel and compute green strength
    green_map = []   # True = background green
    strength_map = []  # 0-1 green strength for feathering
    hsv_cache = []     # (h, s, v) for each pixel

    for r, g, b, a in pixels:
        h, s, v = rgb_to_hsv(r, g, b)
        hsv_cache.append((h, s, v))
        is_bg = _is_green_hsv(h, s, v, hue_min, hue_max, sat_min, val_min)
        green_map.append(is_bg)
        strength_map.append(_green_strength(h, s, v, hue_center, hue_min, hue_max))

    result_pixels = list(pixels)
    edge_radius = 6

    for y in range(height):
        for x in range(width):
            idx = y * width + x
            r, g, b, a = pixels[idx]
            h, s, v = hsv_cache[idx]

            # Fully green background → transparent
            if green_map[idx]:
                result_pixels[idx] = (r, g, b, 0)
                continue

            # Find distance to nearest background green pixel
            min_dist = 999
            for dx in range(-edge_radius, edge_radius + 1):
                for dy in range(-edge_radius, edge_radius + 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < width and 0 <= ny < height:
                        if green_map[ny * width + nx]:
                            d = (dx * dx + dy * dy) ** 0.5
                            min_dist = min(min_dist, d)

            if min_dist > edge_radius:
                continue  # Far from green, keep as-is

            proximity = max(0, (edge_radius - min_dist) / edge_radius)
            gstr = strength_map[idx]  # How green is this pixel (0-1)

            # Case 1: Pixel has green hue AND is near background
            # → fade alpha based on green strength and proximity
            if gstr > 0.2 and proximity > 0.1:
                remove_factor = proximity * gstr
                if remove_factor > 0.08:
                    new_alpha = int(a * (1 - remove_factor))
                    result_pixels[idx] = (r, g, b, max(0, new_alpha))
                    continue

            # Case 2: Pixel is very close to background and somewhat green
            # → reduce green channel to remove spill, preserve original color
            if gstr > 0.15 and proximity > 0.4 and s > 0.1:
                # Lower the green channel toward max(R, B)
                excess_green = g - max(r, b)
                if excess_green > 5:
                    ng = max(r, b) + int(excess_green * 0.2)
                    result_pixels[idx] = (r, min(g, ng), b, a)

    img.putdata(result_pixels)
    return img


# ---------------------------------------------------------------------------
# Green screen removal — smart (auto-detect from corners)
# ---------------------------------------------------------------------------

def _sample_corners(img: Image.Image, sample_size: int = 10) -> tuple[int, int, int]:
    """Sample the four corners of the image and return the median RGB."""
    w, h = img.size
    pixels = img.convert("RGBA").load()
    samples = []

    regions = [
        (0, 0, sample_size, sample_size),
        (w - sample_size, 0, w, sample_size),
        (0, h - sample_size, sample_size, h),
        (w - sample_size, h - sample_size, w, h),
    ]
    for x0, y0, x1, y1 in regions:
        for y in range(y0, y1):
            for x in range(x0, x1):
                r, g, b, a = pixels[x, y]
                if a > 0:
                    samples.append((r, g, b))

    if not samples:
        return 51, 255, 0  # fallback to #33ff00

    samples.sort()
    mid = len(samples) // 2
    return samples[mid]


def remove_green_background_smart(img: Image.Image, tolerance: int = 30) -> Image.Image:
    """Auto-detect green background from corner samples, then remove using HSV.

    Samples the four corners to get the actual background color, converts to
    HSV to determine hue range, then delegates to the same HSV-based removal.

    If the corners don't look green at all, returns the image unchanged.
    """
    img = img.convert("RGBA")
    kr, kg, kb = _sample_corners(img)

    # Check if sampled background is actually green using HSV
    kh, ks, kv = rgb_to_hsv(kr, kg, kb)
    if not _is_green_hsv(kh, ks, kv):
        return img

    # Use the sampled hue as center for removal
    # Delegate to main function which already uses HSV
    return remove_green_background(img, tolerance=tolerance)


# ---------------------------------------------------------------------------
# Strip splitting
# ---------------------------------------------------------------------------

def split_evenly(strip: Image.Image, frame_count: int) -> tuple[list[Image.Image], str | None]:
    """Split a horizontal strip into *frame_count* equal-width panels.

    Uses ``math.floor`` for boundaries so that ``width % frame_count != 0``
    does not cause cumulative rounding drift.

    Returns ``(panels, warning_or_None)``.
    """
    width, height = strip.size
    if frame_count <= 0:
        raise ValueError("frames must be greater than 0")
    if width < frame_count:
        raise ValueError(f"image width {width}px is too small for {frame_count} frames")

    warning = None
    if width % frame_count != 0:
        warning = (
            f"Warning: strip width {width}px is not evenly divisible by {frame_count} frames. "
            f"Each frame will be ~{width / frame_count:.1f}px wide."
        )

    frames: list[Image.Image] = []
    for i in range(frame_count):
        left = math.floor(i * width / frame_count)
        right = math.floor((i + 1) * width / frame_count)
        if i == frame_count - 1:
            right = width  # last frame captures any remainder
        frames.append(strip.crop((left, 0, right, height)).convert("RGBA"))

    return frames, warning


# ---------------------------------------------------------------------------
# Subject detection
# ---------------------------------------------------------------------------

def compute_subject_bbox(frame: Image.Image, alpha_threshold: int = 10) -> tuple[int, int, int, int] | None:
    """Return (x, y, w, h) of the largest non-transparent connected region.

    Returns ``None`` if no subject is found.
    """
    frame = frame.convert("RGBA")
    w, h = frame.size
    pixels = frame.load()

    visited = [[False] * h for _ in range(w)]
    best_bbox = None
    best_area = 0

    for sy in range(h):
        for sx in range(w):
            if visited[sx][sy]:
                continue
            if pixels[sx, sy][3] <= alpha_threshold:
                visited[sx][sy] = True
                continue

            # BFS flood fill
            queue = deque()
            queue.append((sx, sy))
            visited[sx][sy] = True
            min_x = max_x = sx
            min_y = max_y = sy
            area = 0

            while queue:
                cx, cy = queue.popleft()
                area += 1
                if cx < min_x:
                    min_x = cx
                if cx > max_x:
                    max_x = cx
                if cy < min_y:
                    min_y = cy
                if cy > max_y:
                    max_y = cy

                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < w and 0 <= ny < h and not visited[nx][ny]:
                        visited[nx][ny] = True
                        if pixels[nx, ny][3] > alpha_threshold:
                            queue.append((nx, ny))

            if area > best_area:
                best_area = area
                best_bbox = (min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)

    # Ignore tiny blobs (< 0.5% of frame area)
    frame_area = w * h
    if best_bbox is not None and best_area < frame_area * 0.005:
        best_bbox = None

    return best_bbox


# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------

def align_frames_to_anchor(
    panels: list[Image.Image],
    output_size: int,
    padding: int = 16,
    lock_body: bool = True,
) -> tuple[list[Image.Image], list[dict], list[tuple[int, int, int, int]]]:
    """Align all frames to a unified bottom-center anchor.

    Returns (aligned_frames, per_frame_debug_info, bboxes).
    """
    bboxes: list[tuple[int, int, int, int] | None] = []
    for panel in panels:
        bboxes.append(compute_subject_bbox(panel))

    # Fallback: if any frame has no subject, use the whole panel
    fallback_boxes = []
    for i, panel in enumerate(panels):
        if bboxes[i] is None:
            w, h = panel.size
            bboxes[i] = (0, 0, w, h)
        fallback_boxes.append(bboxes[i])

    # Global max bbox dimensions
    max_w = max(b[2] for b in bboxes)
    max_h = max(b[3] for b in bboxes)

    if max_w == 0 or max_h == 0:
        # Degenerate — just center everything
        max_w = max_h = 1

    # Unified scale
    avail = output_size - padding * 2
    scale = min(avail / max_w, avail / max_h)

    # Anchor: bottom-center (always lock horizontal center)
    anchor_x = output_size / 2.0
    anchor_y = output_size - padding

    aligned: list[Image.Image] = []
    debug_info: list[dict] = []

    for i, (panel, bbox) in enumerate(zip(panels, bboxes)):
        bx, by, bw, bh = bbox

        # Crop to subject bbox with a small margin
        margin = 4
        crop_x0 = max(0, bx - margin)
        crop_y0 = max(0, by - margin)
        crop_x1 = min(panel.width, bx + bw + margin)
        crop_y1 = min(panel.height, by + bh + margin)
        cropped = panel.crop((crop_x0, crop_y0, crop_x1, crop_y1))

        # Resize by unified scale
        new_w = max(1, round(cropped.width * scale))
        new_h = max(1, round(cropped.height * scale))
        resized = cropped.resize((new_w, new_h), Image.Resampling.LANCZOS)

        # Draw position: center of bbox → anchorX, bottom of bbox → anchorY
        bbox_center_x_in_crop = (bx - crop_x0) + bw / 2.0
        bbox_bottom_in_crop = (by - crop_y0) + bh

        scaled_center_x = bbox_center_x_in_crop * scale
        scaled_bottom = bbox_bottom_in_crop * scale

        draw_x = int(anchor_x - scaled_center_x)
        draw_y = int(anchor_y - scaled_bottom)

        canvas = Image.new("RGBA", (output_size, output_size), (0, 0, 0, 0))
        canvas.alpha_composite(resized, (draw_x, draw_y))
        aligned.append(canvas)

        debug_info.append({
            "frame": i,
            "bbox": list(bbox),
            "scale": round(scale, 4),
            "draw_xy": [draw_x, draw_y],
            "resized_wh": [new_w, new_h],
        })

    return aligned, debug_info, bboxes


# ---------------------------------------------------------------------------
# Subject height normalization (cross-state consistency)
# ---------------------------------------------------------------------------

def normalize_subject_height(
    frames: list[Image.Image],
    output_size: int,
    target_ratio: float = 0.8,
    padding: int = 16,
) -> list[Image.Image]:
    """Scale all frames so the average subject height equals target_ratio of canvas.

    After alignment, different animation states may have different character
    sizes (e.g. calm=433px vs happy=484px in a 512px canvas).  This function
    detects the subject bbox in each frame, computes the average height, and
    uniformly re-scales all frames so that average matches the target.

    The anchor is always bottom-center to preserve alignment.

    Args:
        frames: List of aligned RGBA frames (same size).
        output_size: Canvas dimension in px.
        target_ratio: Desired avg subject height as fraction of canvas (0-1).
        padding: Bottom padding in px.

    Returns:
        New list of normalized frames.
    """
    # Detect subject bbox in each frame
    heights = []
    for frame in frames:
        bbox = compute_subject_bbox(frame)
        if bbox:
            heights.append(bbox[3])  # height

    if not heights:
        return frames  # nothing to normalize

    avg_height = sum(heights) / len(heights)
    target_height = output_size * target_ratio

    # If already close (within 3%), skip
    if abs(avg_height - target_height) / target_height < 0.03:
        return frames

    norm_scale = target_height / avg_height

    # Re-render each frame with the normalization scale
    anchor_x = output_size / 2.0
    anchor_y = output_size - padding
    result = []

    for frame in frames:
        bbox = compute_subject_bbox(frame)
        if not bbox:
            result.append(frame)
            continue

        bx, by, bw, bh = bbox

        # Crop to subject with margin
        margin = 4
        crop_x0 = max(0, bx - margin)
        crop_y0 = max(0, by - margin)
        crop_x1 = min(frame.width, bx + bw + margin)
        crop_y1 = min(frame.height, by + bh + margin)
        cropped = frame.crop((crop_x0, crop_y0, crop_x1, crop_y1))

        # Apply normalization scale
        new_w = max(1, round(cropped.width * norm_scale))
        new_h = max(1, round(cropped.height * norm_scale))
        resized = cropped.resize((new_w, new_h), Image.Resampling.LANCZOS)

        # Recompute draw position with bottom-center anchor
        bbox_center_x_in_crop = (bx - crop_x0) + bw / 2.0
        bbox_bottom_in_crop = (by - crop_y0) + bh

        scaled_center_x = bbox_center_x_in_crop * norm_scale
        scaled_bottom = bbox_bottom_in_crop * norm_scale

        draw_x = int(anchor_x - scaled_center_x)
        draw_y = int(anchor_y - scaled_bottom)

        canvas = Image.new("RGBA", (output_size, output_size), (0, 0, 0, 0))
        canvas.alpha_composite(resized, (draw_x, draw_y))
        result.append(canvas)

    return result


# ---------------------------------------------------------------------------
# Legacy canvas fit (for --no-align mode)
# ---------------------------------------------------------------------------

def fit_to_fixed_canvas(frame: Image.Image, size: int) -> Image.Image:
    frame = frame.convert("RGBA")
    if frame.size == (size, size):
        return frame

    scale = min(size / frame.width, size / frame.height)
    new_w = max(1, round(frame.width * scale))
    new_h = max(1, round(frame.height * scale))

    resized = frame.resize((new_w, new_h), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x = (size - new_w) // 2
    y = (size - new_h) // 2
    canvas.alpha_composite(resized, (x, y))
    return canvas


# ---------------------------------------------------------------------------
# Debug preview
# ---------------------------------------------------------------------------

def make_debug_preview(
    panels: list[Image.Image],
    bboxes: list[tuple[int, int, int, int]],
    output_size: int,
    padding: int,
    out_path: Path,
) -> Path:
    """Generate a debug image showing split boundaries, bboxes, and anchor."""
    n = len(panels)
    cell = 200
    sheet_w = cell * n
    sheet_h = cell + 60  # extra for labels
    sheet = Image.new("RGBA", (sheet_w, sheet_h), (24, 24, 24, 255))
    draw = ImageDraw.Draw(sheet)

    anchor_x = cell // 2
    anchor_y = cell - int(padding * cell / output_size)

    for i, (panel, bbox) in enumerate(zip(panels, bboxes)):
        x_off = i * cell

        # Draw panel thumbnail
        thumb = panel.copy()
        thumb.thumbnail((cell, cell), Image.Resampling.LANCZOS)
        sheet.alpha_composite(thumb, (x_off, 0))

        # Draw bbox
        if bbox:
            bx, by, bw, bh = bbox
            sx = cell / panel.width
            sy = cell / panel.height
            rx0 = x_off + int(bx * sx)
            ry0 = int(by * sy)
            rx1 = x_off + int((bx + bw) * sx)
            ry1 = int((by + bh) * sy)
            draw.rectangle([rx0, ry0, rx1, ry1], outline="red", width=2)

        # Draw anchor crosshair
        ax = x_off + anchor_x
        ay = anchor_y
        draw.line([(ax - 8, ay), (ax + 8, ay)], fill="cyan", width=1)
        draw.line([(ax, ay - 8), (ax, ay + 8)], fill="cyan", width=1)

        # Label
        draw.text((x_off + 4, cell + 4), f"#{i + 1}", fill="white")
        if bbox:
            draw.text((x_off + 4, cell + 20), f"{bbox[2]}x{bbox[3]}", fill="gray")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path)
    return out_path


# ---------------------------------------------------------------------------
# Contact sheet (legacy)
# ---------------------------------------------------------------------------

def clear_old_frames(out_dir: Path, state: str) -> None:
    for path in out_dir.glob(f"{state}_*.png"):
        if path.name.endswith("_contact.png") or path.name.endswith("_debug.png"):
            continue
        path.unlink()


def make_contact_sheet(frame_paths: list[Path], out_path: Path, cell: int = 180) -> Path:
    if not frame_paths:
        raise ValueError("no frames for contact sheet")

    sheet = Image.new("RGBA", (cell * len(frame_paths), cell), (32, 32, 32, 255))
    for index, path in enumerate(frame_paths):
        img = Image.open(path).convert("RGBA")
        thumb = img.copy()
        thumb.thumbnail((cell - 12, cell - 12), Image.Resampling.LANCZOS)
        x = index * cell + (cell - thumb.width) // 2
        y = (cell - thumb.height) // 2
        sheet.alpha_composite(thumb, (x, y))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path)
    return out_path


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def same_file_safe(a: Path, b: Path) -> bool:
    try:
        return a.resolve() == b.resolve()
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Split a transparent horizontal strip into fixed-size PNG frames."
    )
    parser.add_argument("--strip", required=True, type=Path)
    parser.add_argument("--state", required=True)
    parser.add_argument("--skin-dir", default=Path("assets/skins/rick_default"), type=Path)
    parser.add_argument("--frames", default=6, type=int)
    parser.add_argument("--frame-size", default=512, type=int)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--copy-strip", action="store_true")
    parser.add_argument("--contact", action="store_true")
    parser.add_argument("--remove-green", action="store_true",
                        help="Remove green background")
    parser.add_argument("--green-tolerance", default=30, type=int,
                        help="Color tolerance (0-100, default 30)")
    # New alignment options
    parser.add_argument("--align", dest="align", action="store_true", default=True,
                        help="Enable subject auto-alignment (default)")
    parser.add_argument("--no-align", dest="align", action="store_false",
                        help="Disable alignment, use legacy center-on-canvas")
    parser.add_argument("--lock-body", action="store_true", default=True,
                        help="Lock subject center for in-place animations (default)")
    parser.add_argument("--no-lock-body", dest="lock_body", action="store_false",
                        help="Allow horizontal movement for walk/run cycles")
    parser.add_argument("--padding", default=16, type=int,
                        help="Padding from canvas edge in px (default 16)")
    parser.add_argument("--debug-preview", action="store_true",
                        help="Generate debug preview image with bboxes and anchors")
    parser.add_argument("--normalize-height", action="store_true", default=True,
                        help="Normalize subject height across frames (default)")
    parser.add_argument("--no-normalize-height", dest="normalize_height", action="store_false",
                        help="Disable subject height normalization")
    parser.add_argument("--target-ratio", default=0.8, type=float,
                        help="Target subject height as ratio of canvas (default 0.8)")
    args = parser.parse_args()

    if not args.strip.exists():
        raise SystemExit(f"input strip not found: {args.strip}")

    # Open image
    with Image.open(args.strip) as src_img:
        strip = src_img.convert("RGBA")

    # Remove green background
    green_removed = False
    if args.remove_green:
        print("[INFO] Removing green background (smart mode)...", file=sys.stderr)
        strip = remove_green_background_smart(strip, tolerance=args.green_tolerance)
        green_removed = True

        alpha = strip.getchannel("A")
        bbox = alpha.getbbox()
        print(f"[INFO] Done. Content bounds: {bbox}", file=sys.stderr)

    source_w, source_h = strip.size
    if source_h <= 0:
        raise SystemExit("bad input image height")

    actual_ratio = source_w / source_h
    ratio_warning = None
    if abs(actual_ratio - args.frames) > 0.08:
        ratio_warning = (
            f"Warning: input ratio is about {actual_ratio:.2f}:1, not standard {args.frames}:1. "
            "The script will still split it evenly."
        )

    out_dir = args.skin_dir / args.state
    out_dir.mkdir(parents=True, exist_ok=True)

    existing = sorted(
        path for path in out_dir.glob(f"{args.state}_*.png")
        if not path.name.endswith("_contact.png") and not path.name.endswith("_debug.png")
    )
    if existing and not args.force:
        raise SystemExit(
            f"{out_dir} already has {len(existing)} matching frames. Use --force to overwrite."
        )
    if existing and args.force:
        clear_old_frames(out_dir, args.state)

    # Split strip into panels
    panels, split_warning = split_evenly(strip, args.frames)

    warnings = []
    if ratio_warning:
        warnings.append(ratio_warning)
    if split_warning:
        warnings.append(split_warning)

    # --- Alignment mode or legacy mode ---
    alignment_debug = None
    debug_preview_path = None

    if args.align:
        # Subject auto-alignment
        aligned_frames, debug_info, bboxes = align_frames_to_anchor(
            panels, args.frame_size, padding=args.padding, lock_body=args.lock_body,
        )

        # Normalize subject height for cross-state consistency
        if args.normalize_height:
            aligned_frames = normalize_subject_height(
                aligned_frames, args.frame_size,
                target_ratio=args.target_ratio, padding=args.padding,
            )

        saved_paths: list[Path] = []
        for index, frame in enumerate(aligned_frames, start=1):
            out_path = out_dir / f"{args.state}_{index:04d}.png"
            frame.save(out_path)
            saved_paths.append(out_path)

        alignment_debug = {
            "mode": "subject_align",
            "lock_body": args.lock_body,
            "padding": args.padding,
            "normalize_height": args.normalize_height,
            "target_ratio": args.target_ratio,
            "frames": debug_info,
        }

        if args.debug_preview:
            dp_path = out_dir / f"{args.state}_debug.png"
            make_debug_preview(panels, bboxes, args.frame_size, args.padding, dp_path)
            debug_preview_path = str(dp_path)
    else:
        # Legacy: center on canvas
        saved_paths: list[Path] = []
        for index, panel in enumerate(panels, start=1):
            frame = fit_to_fixed_canvas(panel, args.frame_size)
            out_path = out_dir / f"{args.state}_{index:04d}.png"
            frame.save(out_path)
            saved_paths.append(out_path)

        alignment_debug = {"mode": "legacy_center"}

    copied_strip = None
    copy_note = None
    if args.copy_strip:
        strip_dir = args.skin_dir / "_generated_strips"
        strip_dir.mkdir(parents=True, exist_ok=True)
        copied_strip_path = strip_dir / f"{args.state}_cutout_strip.png"

        if same_file_safe(args.strip, copied_strip_path):
            copied_strip = str(copied_strip_path)
            copy_note = "Skipped copy because source and destination are the same file."
        else:
            shutil.copy2(args.strip, copied_strip_path)
            copied_strip = str(copied_strip_path)

    contact_path = None
    if args.contact:
        contact = out_dir / f"{args.state}_contact.png"
        make_contact_sheet(saved_paths, contact)
        contact_path = str(contact)

    result = {
        "state": args.state,
        "source_strip": str(args.strip),
        "source_size": [source_w, source_h],
        "frames": args.frames,
        "frame_size": [args.frame_size, args.frame_size],
        "output_dir": str(out_dir),
        "output_files": [str(path) for path in saved_paths],
        "copied_strip": copied_strip,
        "copy_note": copy_note,
        "contact": contact_path,
        "green_removed": green_removed,
        "alignment": alignment_debug,
        "debug_preview": debug_preview_path,
    }
    if warnings:
        result["warning"] = "\n".join(warnings)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
