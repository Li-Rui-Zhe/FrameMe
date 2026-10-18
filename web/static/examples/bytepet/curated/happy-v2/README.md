# 开心动作优化演示

这组素材基于 BytePet 原始 happy 动作，通过内置 imagegen 修补与重绘：补全天线圆球，整理轮廓，保留六帧动作顺序，再用工作台现有纯色去底、切帧与统一画布流程制作透明 PNG。

原始 `../../happy-strip.png`、`../../happy-thumbnail.png`、`../../frames/happy_*.png` 保留不变；原始 SHA-256 与派生帧校验值分别记录在 `../../example.json` 的 `sha256`、`derived_sha256`。本目录为优化演示，不是原仓库未经修改的素材。

`repair-source.png` 是最终 AI 输出的绿幕母版。重新制作：

```powershell
python -m tools.build_repaired_happy_example --source web/static/examples/bytepet/curated/happy-v2/repair-source.png
```

最终 imagegen Prompt（内置工具模式，非 CLI）：

> Create a production-quality clean-edged version of this exact six-frame white-and-blue robot HAPPY animation sheet. Paint on a COMPLETELY SOLID uniform chroma green #33ff00 background, NOT transparency. SIX equally spaced robots in ONE horizontal row. Preserve the exact six poses and expressions and small round cyan ball antenna on EVERY head, complete body and feet. Repaint the outer contour cleanly with smooth continuous navy outline, remove ALL ragged white triangular scraps, cyan speckles, jagged cutout artifacts around antennas, ears, hands, torsos and feet. All exterior space must be flat pure #33ff00 green. No shadows, no texture, no gradients in background, no text, no panel borders. Consistent character scale and baseline, safe margins inside each of six equal cells. 3072x512 very wide 6:1 strip requested. This green-screen master will be processed by our own background removal pipeline; do NOT output transparent background. Keep robot design, white body, blue face, cyan eyes, heart and glossy round cyan ball on head.

最终母版实际为 2172×724；工作台等分六格，再按透明主体统一到 512×512，底部留白 24px。PNG、长条与缩略图均来自同一组处理结果。
