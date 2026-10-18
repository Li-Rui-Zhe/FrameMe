"""Verify real browser downloads and update the existing Obsidian report."""
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
EVIDENCE = ROOT / '.runtime/upload-evidence'
MATERIAL = ROOT / 'web/static/examples/bytepet'
START = '<!-- framelab-upload-update:start -->'
END = '<!-- framelab-upload-update:end -->'


def verify_downloads():
    records = []
    with zipfile.ZipFile(EVIDENCE / 'uploaded-split.zip') as archive:
        assert archive.testzip() is None
        pngs = [name for name in archive.namelist() if name.endswith('.png')]
        assert pngs == ['my_art_0001.png'], pngs
        with Image.open(io.BytesIO(archive.read(pngs[0]))) as result, Image.open(MATERIAL / 'originals/comfort_0001_uploaded_input.png') as original:
            assert result.size == original.size == (1254, 1254)
            assert result.convert('RGBA').tobytes() == original.convert('RGBA').tobytes()
    records.append({'id': 'UPLOAD-FILE-01', 'name': '新上传切帧 ZIP 仅含用户原图对应结果，完整像素一致', 'status': 'PASS'})

    with Image.open(EVIDENCE / 'uploaded-cutout.png') as image, Image.open(MATERIAL / 'originals/comfort_0001_uploaded_input.png') as original:
        assert image.size == original.size == (1254, 1254)
        result = image.convert('RGBA')
        assert all(result.getpixel(point)[3] == 0 for point in [(0, 0), (1253, 0), (0, 1253), (1253, 1253)])
        assert result.getpixel((627, 627))[3] == 255
        assert result.getpixel((627, 627))[:3] == original.convert('RGBA').getpixel((627, 627))[:3]
    records.append({'id': 'UPLOAD-FILE-02', 'name': '新上传人物抠图 PNG 尺寸正确、四角透明且主体中心保留', 'status': 'PASS'})

    catalog = json.loads((MATERIAL / 'example.json').read_text(encoding='utf-8'))
    originals = [file for entry in catalog['states'] for file in entry['frame_files']][:12]
    with zipfile.ZipFile(EVIDENCE / 'uploaded-rename.zip') as archive:
        assert archive.testzip() is None
        assert len([name for name in archive.namelist() if name.endswith('.png')]) == 12
        for index, file in enumerate(originals, 1):
            with Image.open(io.BytesIO(archive.read(f'asset_{index:04d}.png'))) as result, Image.open(MATERIAL / file) as original:
                assert result.size == original.size
                assert result.convert('RGBA').tobytes() == original.convert('RGBA').tobytes()
    records.append({'id': 'UPLOAD-FILE-03', 'name': '十二张新上传命名 ZIP 连续编号，12/12 完整像素一致', 'status': 'PASS'})
    (EVIDENCE / 'upload-artifact-audit.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
    return records


def update_report(report):
    results = json.loads((EVIDENCE / 'upload-results.json').read_text(encoding='utf-8'))
    isolation = json.loads((ROOT / '.runtime/session-evidence/isolation-results.json').read_text(encoding='utf-8'))
    regression = json.loads((ROOT / '.runtime/test-evidence/browser-results.json').read_text(encoding='utf-8'))
    assert results['failed'] == 0 and results['passed'] == 15
    assert isolation['failed'] == 0 and isolation['passed'] == 16
    assert regression['failed'] == 0 and regression['passed'] == 34
    audits = verify_downloads()
    now = datetime.now(timezone(timedelta(hours=8)))
    destination = report.parent / '附件' / now.strftime('FrameMe-上传切换-%Y%m%d-%H%M%S')
    destination.mkdir(parents=True, exist_ok=True)
    for name in ['upload-results.json', 'upload-artifact-audit.json', 'jobs.json', 'uploaded-split.zip', 'uploaded-cutout.png', 'uploaded-rename.zip', 'split-user-upload.png', 'cutout-user-result.png', 'mobile-user-upload.png']:
        shutil.copyfile(EVIDENCE / name, destination / name)
    shutil.copyfile(ROOT / '.runtime/session-evidence/isolation-results.json', destination / 'isolation-results.json')
    shutil.copyfile(ROOT / '.runtime/test-evidence/browser-results.json', destination / 'browser-results.json')
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in ['web/static/app.js', 'web/static/app.css', 'tests/browser_upload_transition.cjs']}
    (destination / 'implementation-hashes.json').write_text(json.dumps(hashes, indent=2), encoding='utf-8')
    relative = destination.relative_to(report.parent).as_posix()
    lines = [START, f'## {now:%Y-%m-%d %H:%M} 更新：试用后上传自己的图片', '',
        '上次回归漏测了“先一键试用，再上传自己的图片”的连续操作。本次在真实浏览器重现并修复，以下为最新结论。', '',
        '**原因：** 新上传图片被追加到示例后面，预览索引仍为第一张示例。复现时列表已有 `calm-bytepet-strip.png` 和 `star_uploaded_input.png`，但预览名称仍是 `calm-bytepet-strip.png`、尺寸仍为 3072×512，而用户新图为 1254×1254。另一个问题是任务处理/示例加载期间的上传会被直接忽略。', '',
        '**现在的行为：**', '',
        '- 首次上传自己的图片时，自动替换试用素材并清掉旧结果，立即显示新原图且滚动回预览区域。',
        '- 示例如帧数、文件前缀等专用参数恢复为当前工具默认值；切帧先按 1 帧处理，请按自己的素材设置实际帧数。',
        '- 后续上传自己的素材仍可追加，预览自动显示新上传图片；点击素材名称可切换原图。',
        '- 任务处理或示例加载期间收到的上传会提示已接收，暂存到当前工具工作区，结束后自动导入；不将用户图片自动套用为示例任务。',
        '- 图片成功解码后才替换示例；格式错误、重复或损坏的上传不会破坏已有素材和可下载结果。', '',
        '**本次复测：新增 15 项上传回归、原有 34 项浏览器功能回归及 16 项隔离/易用性回归全部通过，共 65 项浏览器检查；新增 3 项真实下载文件核验通过。** 本次修改前端与相关回归脚本，后端算法未改动。此前 45 项后端检查结果仍保留在后文，不计入本次新执行数量。', '',
        '| 编号 | 场景 | 结果 |', '| --- | --- | --- |']
    for row in results['results'] + audits:
        lines.append(f"| {row['id']} | {row['name']} | {row['status']} |")
    lines += ['', '### 上传后的实际界面', '',
        f'![切帧试用后上传新原图]({relative}/split-user-upload.png)', '',
        f'![用户人物原图的抠图结果]({relative}/cutout-user-result.png)', '',
        f'![手机上传后显示用户原图]({relative}/mobile-user-upload.png)', '',
        '### 证据', '',
        f'- [新增上传回归结果]({relative}/upload-results.json)',
        f'- [原有功能复测]({relative}/browser-results.json)',
        f'- [隔离与易用性复测]({relative}/isolation-results.json)',
        f'- [真实下载文件核验]({relative}/upload-artifact-audit.json)',
        f'- [用户原图切帧 ZIP]({relative}/uploaded-split.zip)',
        f'- [用户人物抠图 PNG]({relative}/uploaded-cutout.png)',
        f'- [十二张命名结果 ZIP]({relative}/uploaded-rename.zip)', '',
        '复现脚本：`tests/browser_upload_transition.cjs`。与现有浏览器测试相同，需要本地服务运行于 127.0.0.1:7860，并通过 `FRAMELAB_PLAYWRIGHT`、`FRAMELAB_BROWSER_PATH` 指定 Playwright 与浏览器路径。', '', END, '']
    text = report.read_text(encoding='utf-8').replace('# FrameLab 动画与图片素材工作台测试报告\n', '# 帧的么 FrameMe 动画与图片素材工作台测试报告\n', 1)
    if START in text:
        start, end = text.index(START), text.index(END) + len(END)
        text = text[:start] + text[end:].lstrip('\n')
    heading = '# 帧的么 FrameMe 动画与图片素材工作台测试报告\n'
    assert heading in text
    text = text.replace(heading, heading + '\n' + '\n'.join(lines) + '\n', 1)
    report.write_text(text, encoding='utf-8')
    print(f'Upload tests: {results["passed"]}; browser regression: {regression["passed"]}; isolation: {isolation["passed"]}; artifact audits: {len(audits)}')
    print(f'Report updated: {report}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    update_report(args.report)
