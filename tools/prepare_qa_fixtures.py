"""Build test fixtures and review boards from actual project material."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "web/static/examples/bytepet"
DEST = ROOT / ".runtime/test-evidence"


def prepare():
    DEST.mkdir(parents=True, exist_ok=True)
    frames = [Image.open(EXAMPLE / f"frames/calm_{index:04d}.png").convert("RGBA") for index in range(1, 7)]
    vertical = Image.new("RGBA", (512, 3072))
    grid = Image.new("RGBA", (1536, 1024))
    for index, image in enumerate(frames):
        vertical.paste(image, (0, index * 512))
        grid.paste(image, ((index % 3) * 512, (index // 3) * 512))
    vertical.save(DEST / "bytepet-vertical.png")
    grid.save(DEST / "bytepet-grid.png")
    frames[0].convert("RGB").save(DEST / "bytepet-original.jpg", quality=95)
    frames[1].save(DEST / "bytepet-original.webp", lossless=True)

    font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
    for name in ["star_uploaded_input.png", "comfort_0001_uploaded_input.png"]:
        board = Image.new("RGB", (1044, 560), "#f5f6f2")
        draw = ImageDraw.Draw(board)
        original = Image.open(EXAMPLE / "originals" / name).convert("RGBA")
        result = Image.open(ROOT / ".runtime/review" / name).convert("RGBA")
        for index, image in enumerate([original, result]):
            x = 10 + index * 522
            draw.text((x + 6, 10), "原始绿幕素材" if index == 0 else "处理结果（棋盘背景）", font=font, fill="#293233")
            checker = Image.new("RGBA", (512, 512), "#f5f5ef")
            checker_draw = ImageDraw.Draw(checker)
            for y in range(0, 512, 16):
                for cx in range(0, 512, 16):
                    if (cx // 16 + y // 16) % 2:
                        checker_draw.rectangle((cx, y, cx + 15, y + 15), fill="#e4e7df")
            checker.alpha_composite(image.resize((512, 512), Image.Resampling.LANCZOS))
            board.paste(checker.convert("RGB"), (x, 40))
        board.save(DEST / ("review-" + name))


if __name__ == "__main__":
    prepare()
