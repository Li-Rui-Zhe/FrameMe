"""Append verified workspace/session and usability regression evidence."""
import argparse
import hashlib
import io
import json
import shutil
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / ".runtime/session-evidence"


def verify_direct_downloads():
    originals = ROOT / "web/static/examples/bytepet/frames"
    for zip_name, prefix in [("split-direct.zip", "calm"), ("rename-direct.zip", "asset")]:
        with zipfile.ZipFile(EVIDENCE / zip_name) as archive:
            assert archive.testzip() is None
            for index in range(1, 7):
                result = Image.open(io.BytesIO(archive.read(f"{prefix}_{index:04d}.png"))).convert("RGBA")
                with Image.open(originals / f"calm_{index:04d}.png") as original:
                    assert result.size == original.size == (512, 512)
                    assert result.tobytes() == original.convert("RGBA").tobytes()
    for name in ["cutout-direct.png", "mobile-cutout.png"]:
        with Image.open(EVIDENCE / name) as image:
            assert image.size == (1254, 1254)
            assert image.convert("RGBA").getpixel((0, 0))[3] == 0


def append(report):
    verify_direct_downloads()
    results = json.loads((EVIDENCE / "isolation-results.json").read_text(encoding="utf-8"))
    backend = json.loads((ROOT / ".runtime/test-evidence/backend-results.json").read_text(encoding="utf-8"))
    assert results["failed"] == 0 and results["passed"] == 16
    assert backend["failed"] == 0 and backend["errors"] == 0 and backend["passed"] == 45
    now = datetime.now(timezone(timedelta(hours=8)))
    destination = report.parent / "附件" / now.strftime("FrameMe-会话隔离-%Y%m%d-%H%M%S")
    destination.mkdir(parents=True, exist_ok=True)
    for source in EVIDENCE.iterdir():
        if source.is_file():
            shutil.copyfile(source, destination / source.name)
    for name in ["backend-results.json", "backend-tests.log", "browser-results.json", "export-audit.json"]:
        shutil.copyfile(ROOT / ".runtime/test-evidence" / name, destination / name)
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in [
        "app.py", "web/index.html", "web/static/app.js", "web/static/app.css",
    ]}
    (destination / "implementation-hashes.json").write_text(json.dumps(hashes, indent=2), encoding="utf-8")
    relative = destination.relative_to(report.parent).as_posix()
    lines = [
        f"## {now.strftime('%Y-%m-%d %H:%M')} 更新：工作区隔离与一键使用", "",
        "**此前的 80 项检查漏测了工具往返切换与会话权限，不能据此认定这些场景已经正确。** 本次按实际截图重现原因并增加专门覆盖。",
        "最新复测：45 项图像/接口测试通过（包含新增 8 项后端会话检查），16 项新增浏览器隔离与易用性场景通过。原有 34 项浏览器功能回归与 9 项文件核验也通过。本节是当前实现的更新结论，后文保留先前报告作为历史记录。", "",
        "### 隔离修复", "",
        "- 序列帧切割、背景移除、批量命名各自持有素材、参数、结果、预览、播放速度与高级设置展开状态。来回切换只恢复该工具的工作区，不把其他工具的素材带进来。",
        "- 异步示例和历史请求绑定原工作区及视图版本；迟到的响应不能覆盖当前工具或把用户强行切回旧页面。",
        "- 最近任务保存在当前标签页的 sessionStorage，新标签页不显示另一个标签页的任务记录；刷新保留该标签页历史。",
        "- 所有任务元信息、原图、帧图片及 ZIP/PNG/GIF 导出都验证浏览器会话归属。另一浏览器会话即使知道任务 ID，仍返回 404。",
        "- 签名 Cookie 使用 HttpOnly 和 SameSite=Lax。不同标签页在同一浏览器中仍属于同一浏览器身份；这里实现的是独立的标签页工作区/历史，以及不同浏览器会话的任务权限隔离。",
        "- 工作区文件留在当前页面内存，刷新后可通过最近任务恢复已完成结果；不把未提交的原始图片自动写入浏览器长期存储。旧的无归属任务不会并入新会话。", "",
        "### 操作简化", "",
        "1. 选择示例，点击 **一键试用**，自动套用该工具的预设并生成结果，不需要再次点击处理。",
        "2. 结果上方直接显示 **下载结果**：单张抠图下载透明 PNG，切帧和批量命名下载 ZIP。",
        "3. 高级设置默认收起；只有想调整尺寸、裁剪、颜色容差或对齐时才打开。",
        "4. 上传自己的素材时，保留原始尺寸作为默认值，按钮明确写为“生成动画帧”“移除背景”或“批量改名”。", "",
        "新版流程为 **选示例/上传图片 → 一键生成 → 下载结果**。下载入口位于预览上方，浏览器检查确认桌面首屏无需向下寻找。", "",
        "### 新增浏览器回归结果", "",
        "| 编号 | 场景 | 结果 |", "| --- | --- | --- |",
    ]
    for row in results["results"]:
        lines.append(f"| {row['id']} | {row['name']} | {row['status']} |")
    lines += [
        "", "新下载路径也单独验证：切帧与命名的直接下载 ZIP 各 6 张，均与 BytePet 原始 PNG 完整像素一致；桌面与手机直接下载的抠图 PNG 保持 1254×1254 且背景角落透明。未改动图像算法，本次不宣称已消除此前记录的细边缘绿边。", "",
        "### 最新界面", "",
        f"![切帧一键试用]({relative}/split-one-click.png)", "",
        f"![背景移除一键试用]({relative}/cutout-one-click.png)", "",
        f"![批量命名一键试用]({relative}/rename-one-click.png)", "",
        f"![手机一键使用]({relative}/mobile-one-click.png)", "",
        "### 当前证据与复现", "",
        f"- [16项隔离与易用性检查 JSON]({relative}/isolation-results.json)",
        f"- [45项后端测试 JSON]({relative}/backend-results.json)",
        f"- [后端完整日志]({relative}/backend-tests.log)",
        f"- [原有34项浏览器回归]({relative}/browser-results.json)",
        f"- [9项原有下载文件核验]({relative}/export-audit.json)",
        f"- [当前实现文件 SHA-256]({relative}/implementation-hashes.json)",
        f"- [一键切帧直接下载 ZIP]({relative}/split-direct.zip)",
        f"- [一键命名直接下载 ZIP]({relative}/rename-direct.zip)",
        f"- [一键抠图直接下载 PNG]({relative}/cutout-direct.png)", "",
        "运行新增浏览器检查：`node tests/browser_isolation.cjs`（与先前浏览器检查使用同一 Playwright / 浏览器环境变量）。后端检查仍为 `python tools/run_test_suite.py`。会话签名密钥未复制到报告附件。", "",
        "---", "", "## 先前版本功能测试记录", "",
    ]
    text = report.read_text(encoding="utf-8").replace('# FrameLab 动画与图片素材工作台测试报告\n', '# 帧的么 FrameMe 动画与图片素材工作台测试报告\n', 1)
    title = "# 帧的么 FrameMe 动画与图片素材工作台测试报告\n"
    assert title in text
    text = text.replace(title, title + "\n" + "\n".join(lines), 1)
    report.write_text(text, encoding="utf-8")
    print("Updated report:", str(report))
    print("Isolation checks: 45 backend + 16 new browser cases passed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    append(args.report.resolve())
