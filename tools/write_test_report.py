"""Create an Obsidian-ready report from completed test evidence."""
import argparse
import hashlib
import json
import platform
import shutil
import sys
from datetime import datetime, timedelta, timezone
from importlib.metadata import version
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / ".runtime/test-evidence"


def load(name):
    return json.loads((EVIDENCE / name).read_text(encoding="utf-8"))


def create_report(destination, replace=False):
    destination.mkdir(parents=True, exist_ok=True)
    backend, browser, exports = load("backend-results.json"), load("browser-results.json"), load("export-audit.json")
    environment = load("browser-environment.json")
    if backend["failed"] or backend["errors"] or browser["failed"] or exports["failed"]:
        raise ValueError("存在未通过的检查，不生成通过报告")
    now = datetime.now(timezone(timedelta(hours=8)))
    date = now.strftime("%Y-%m-%d")
    assets = destination / "附件" / ("FrameMe-" + now.strftime("%Y%m%d-%H%M%S"))
    assets.mkdir(parents=True, exist_ok=True)
    for path in EVIDENCE.iterdir():
        if path.is_file():
            shutil.copyfile(path, assets / path.name)
    relative = assets.relative_to(destination).as_posix()
    catalog = json.loads((ROOT / "web/static/examples/bytepet/example.json").read_text(encoding="utf-8"))
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in [
        "app.py", "tools/image_pipeline.py", "web/static/app.js", "web/static/app.css",
        "web/static/examples/bytepet/example.json",
    ]}
    (assets / "implementation-hashes.json").write_text(json.dumps(hashes, indent=2), encoding="utf-8")
    total = backend["total"] + len(browser["results"]) + len(exports["results"])
    lines = [
        "---", f"date: {date}", "tags: [FrameMe, 动画素材, 功能测试]", "status: 核心功能通过，抠图精细边缘有限", "---", "",
        "# 帧的么 FrameMe 动画与图片素材工作台测试报告", "",
        f"测试时间：{now.strftime('%Y-%m-%d %H:%M:%S')}（Asia/Shanghai）。",
        f"项目目录：`{ROOT}`。本地访问地址：[帧的么 FrameMe](http://127.0.0.1:7860/)。", "",
        "## 结论", "",
        f"本次完成 **{total} 项分层检查，全部通过**：{backend['passed']} 项图像与 HTTP 接口测试、{browser['passed']} 项浏览器操作场景、{exports['passed']} 项浏览器下载文件核验。失败 0，后端跳过 {backend['skipped']}。这些数字对应本报告定义的检查项目，不表示穷尽所有组合。",
        "序列帧切割、批量命名、纯色背景移除、任务记录与各类导出，在本次 Windows + Edge 环境下可正常使用。PNG 切帧和批量命名的真实素材已做完整像素比较，下载文件也实际解压与解码检查。",
        "**背景移除的功能通过，但还不是精修级抠图。** 真实绿幕素材的背景样本透明、主体样本未改变；星球轨道及人物发丝等细边缘仍可见少量绿边。不能把这次检查理解为复杂照片、全部毛发边缘或主体中相近绿色都处理完美。", "",
        "## 三个工具分别使用不同演示", "",
        "| 工具 | 演示输入 | 实际操作 | 预期结果 |",
        "| --- | --- | --- | --- |",
        "| 序列帧切割 | BytePet calm / happy / run_right 原始透明帧组成的横向长条 | 按动作帧数切割，以原 FPS 播放 | 512×512 透明 PNG；动作目录 ZIP |",
        "| 背景移除 | 原工具保留的星球图标、人物立绘绿幕原始上传文件 | 自动取色或手动从原图取色，移除纯色背景 | 1254×1254 透明 PNG，可切换原图对比 |",
        "| 批量命名 | BytePet 多张独立原始 PNG，而非长条 | 改为 asset_0001.png 等连续编号 | 全部结果列表、旧名→新名；原像素与尺寸不变 |", "",
        "载入演示会保持当前工具。背景移除页不再演示动画切割；批量命名页会一次载入多张图片，并展示全部命名结果。GIF 导出在命名页隐藏，因为独立图片的批量命名不是动画序列。",
        "BytePet 单动作目录只用于替换已有完整角色的对应动作，不能单独当完整角色包导入。原项目的资源校验仍要求其他动作、box 和短动作目录。", "",
        "## 素材来源与真实性", "",
        f"- BytePet 原素材固定到提交 `{catalog['commit']}`：[来源仓库]({catalog['repository']}/tree/{catalog['commit']})。",
        "- 命名演示保存原 PNG 文件本身；16 张原始帧的 SHA-256 与来源记录一致。切帧示例只做排列，不生成替代角色。",
        "- 星球绿幕原图：`assets/skins/rick_default/_generated_strips/star_uploaded_input.png`。",
        "- 人物绿幕原图：`assets/skins/rick_default/_generated_strips/comfort_0001_uploaded_input.png`。",
        "- 两张绿幕演示文件与本地原始上传文件逐字节一致，没有给已抠好的图补上绿色背景，也没有重画素材。",
        "- 绿幕素材来自本地原工具，单独记录来源，不将它们描述成 BytePet 公开仓库里的文件。",
        "- 纵向、网格及 JPEG/WebP 测试输入从同一批真实原帧按测试需要排布或转码，属于明确的测试派生输入。", "",
        "## 测试环境与范围", "",
        f"| 项目 | 实际环境 |", "| --- | --- |",
        f"| 系统 | {platform.platform()} |",
        f"| Python | {platform.python_version()} |",
        f"| Flask / Pillow | {version('Flask')} / {version('Pillow')} |",
        f"| 浏览器 | Microsoft Edge，Chromium {environment['browser']}，Playwright 自动操作 |",
        "| 布局 | 1440×1100 桌面；390×844 手机视口；768×1024 平板视口 |",
        "| 服务 | 本机 127.0.0.1:7860；Flask 开发服务 |", "",
        "API、图像算法、用户操作、真实下载文件分别验证。浏览器检查使用无界面浏览器；手机和平板检查为视口模拟，不是实体设备。未验证公开部署、Safari/Firefox、真实多用户压测及长期磁盘增长。繁忙 429、上传 413、像素与帧数限制只按本报告列出的接口边界场景验证。", "",
        "## 本次发现并修复的问题", "",
        "| 问题 | 影响 | 修复后结果 |", "| --- | --- | --- |",
        "| 三种工具共用切帧案例，载入会跳回切帧 | 抠图与命名演示无法代表实际用途 | 按工具载入独立原始输入，保持当前工具 |",
        "| 命名页示例包含 _01_0001，与真实连续编号不同 | 用户看到的规则与下载结果不一致 | 统一为 prefix_0001，浏览器及 ZIP 验证一致 |",
        "| 命名结果只显示一个素材组 | 多张结果难以一起核对 | 命名页展示全部图片，提供旧名→新名 |",
        "| 其他工具继续提交隐藏的切帧参数 | 切换后可能因无关参数被拒绝 | 前后端按模式过滤无关参数，回归通过 |",
        "| 非有限数值转换可能落入服务端错误 | 非法 API 输入可能返回 500 | 整数校验返回 400，布尔、空值、Infinity、NaN 等检查通过 |",
        "| 超过上传限制的 413 被通用异常处理吞掉 | 实际返回 500，提示不准确 | 保留 HTTP 异常，返回 413 与 40 MB 提示；已用在线服务复核 |",
        "| 背景移除自动取色文字被浮动标题挤成竖排 | 参数区阅读与操作体验异常 | 清除浮动布局影响，新增文字宽高检查并更新截图 |", "",
        "浏览器测试脚本还修正了一次任务恢复的等待条件：等待工作台显示且新图片完成加载，避免把隐藏的旧 DOM 当成恢复后的结果。这个调整不是把失败场景删除。", "",
        "## 图像与导出文件核验", "",
        "| 编号 | 检查 | 结果 | 证据 |", "| --- | --- | --- | --- |",
    ]
    for row in exports["results"]:
        detail = row.get("detail", "")
        if isinstance(detail, dict):
            detail = f"{detail['size'][0]}×{detail['size'][1]}；透明像素 {detail['transparent_percent']}%；半透明像素 {detail['partial_alpha_pixels']}；背景 {detail['background_samples']}；主体 {detail['foreground_samples']}"
        lines.append(f"| {row['id']} | {row['name']} | {row['status']} | {detail} |")
    lines += [
        "", "PNG 像素比较覆盖全部切帧和全部命名输出，不只比较文件大小或名称。JPEG/WebP 比较的是解码后的输入；JPEG 已有压缩损失不被声称已恢复。GIF 做帧数、速度、循环、透明验证，因其调色板量化不做 PNG 级像素一致承诺。",
        "绿幕原图没有人工标注的完整抠图真值，本次使用背景与主体固定点、alpha 统计及视觉对照评审，因此不宣称全部边缘已正确分割。", "",
        "## 截图与抠图对照", "",
        "### 序列帧切割", "", f"![切帧工作台]({relative}/split-desktop.png)", "",
        "### 背景移除：原图与结果", "", f"![绿幕原图工作台]({relative}/cutout-before.png)", "", f"![透明结果工作台]({relative}/cutout-after.png)", "",
        f"![星球绿幕前后对照]({relative}/review-star_uploaded_input.png)", "",
        f"![人物绿幕前后对照]({relative}/review-comfort_0001_uploaded_input.png)", "",
        "对照图使用棋盘底色合成以便审查透明区域；输出 PNG 本身仍保留真实 alpha 通道。", "",
        "### 批量命名", "", f"![六张真实原帧命名结果]({relative}/rename-desktop.png)", "",
        "### 手机和深色界面", "", f"![背景移除手机界面]({relative}/cutout-mobile.png)", "", f"![批量命名手机界面]({relative}/rename-mobile.png)", "", f"![深色界面]({relative}/rename-dark.png)", "",
        "## 浏览器操作清单", "",
        "| 编号 | 场景 | 结果 |", "| --- | --- | --- |",
    ]
    for row in browser["results"]:
        lines.append(f"| {row['id']} | {row['name']} | {row['status']} |")
    lines += ["", "## 图像与接口自动测试清单", "", "| 用例 | 结果 |", "| --- | --- |"]
    for row in backend["results"]:
        lines.append(f"| `{row['id'].split('.')[-1]}` | {row['status']} |")
    lines += [
        "", "## 复现与完整证据", "",
        "在项目目录运行：", "", "```powershell", "python tools/run_test_suite.py",
        "# 浏览器脚本需要可用的 Playwright 与浏览器，可通过环境变量指定路径。",
        "# FRAMELAB_PLAYWRIGHT 指向 Playwright 模块；FRAMELAB_BROWSER_PATH 指向浏览器可执行文件。",
        "node tests/browser_regression.cjs", "python tools/audit_exports.py", "```", "",
        "浏览器检查需要本地服务运行，以及 tools/prepare_qa_fixtures.py 准备的派生输入；不需要改动 BytePet 原项目。",
        f"- [后端完整日志]({relative}/backend-tests.log)",
        f"- [后端逐项 JSON]({relative}/backend-results.json)",
        f"- [浏览器逐项 JSON]({relative}/browser-results.json)",
        f"- [下载文件核验 JSON]({relative}/export-audit.json)",
        f"- [环境信息]({relative}/browser-environment.json)",
        f"- [本次实现文件 SHA-256]({relative}/implementation-hashes.json)",
        f"- [切帧动作目录 ZIP]({relative}/split-folders.zip)",
        f"- [真实六张 PNG 命名 ZIP]({relative}/rename-six.zip)",
        f"- [星球透明 PNG]({relative}/star-cutout.png)",
        f"- [人物透明 PNG]({relative}/portrait-cutout.png)",
        "", "附件一并保存在本笔记目录内，可在 Obsidian 中打开或移走归档。原始素材没有被本次测试覆盖改写。报告所称“通过”仅针对上述已执行场景和当前本地实现。", "",
    ]
    report = destination / f"{date}_FrameMe功能测试报告.md"
    if report.exists() and not replace:
        report = destination / f"{date}_{now.strftime('%H%M%S')}_FrameMe功能测试报告.md"
    report.write_text("\n".join(lines), encoding="utf-8")
    print(str(report))
    print(f"Evidence directory: {assets}")
    print(f"Passed checks: {total}")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()
    create_report(args.output_dir.resolve(), replace=args.replace)
