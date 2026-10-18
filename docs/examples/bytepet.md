# BytePet：用真实项目演示素材处理

案例来自 [Li-Rui-Zhe/BytePet](https://github.com/Li-Rui-Zhe/BytePet)，固定到提交 `8433f2d754f19df5bbcf0833a9271479d86e3754`。帧的么 FrameMe 是通用素材工具，BytePet 是其中一个可直接操作的案例。平静待机与向右跑保留原始帧；开心默认使用 AI 修补与重绘的优化演示版，补全天线圆球、整理轮廓与安全留白，原始文件另外保留。

## 载入并处理

1. 在工作台的“真实项目案例”中选择动作，再点击“一键试用”，自动生成可下载结果。
2. 默认保留原始 512×512 画布、透明通道和动作前缀；不会移除背景或重排主体。
3. 使用原项目帧率预览，也可以调整设置后重新生成。
4. 在“下载格式”选择“分组图片（ZIP）”，直接下载，解压后得到对应动作目录。

| 案例 | 原项目动作 | 帧数 | 帧率 | 输出 |
| --- | --- | --- | --- | --- |
| 平静待机 | calm | 6 | 4 FPS | `calm/calm_0001.png` 至 `calm/calm_0006.png` |
| 开心 | happy | 6 | 4 FPS | `happy/happy_0001.png` 至 `happy/happy_0006.png` |
| 向右跑 | run_right | 4 | 5 FPS | `run_right/run_right_0001.png` 至 `run_right/run_right_0004.png` |

示例长条由相应独立帧按编号横向排列而成，用来演示“长条 → 切帧 → 动画预览 → 动作目录”的工作流程。开心优化版的长条、独立帧和缩略图均来自同一组透明 PNG。默认处理保持当前示例的像素；更改尺寸、对齐或抠图参数会改变输出。

## 在 BytePet 使用

可以把对应动作目录替换到已有的完整角色素材副本中，再通过 BytePet 的角色资源导入功能使用。建议复制一份完整素材后替换，确认预览正常再采用新资源。

**这些案例是单动作目录，不能单独作为完整角色包导入。** 固定提交的 Rust 校验器要求 19 个标准动作目录、`box/box_0001.png`，以及至少一个包含 6 帧的 `actionN` 短动作目录；还会校验各动作预期帧数、RGBA 通道和所有帧的尺寸一致性。因此，替换 512×512 原角色的动作时应保持 512×512，不要只将一个动作缩小到 256×256。

资料依据：

- [动作帧数与 FPS](https://github.com/Li-Rui-Zhe/BytePet/blob/8433f2d754f19df5bbcf0833a9271479d86e3754/src/config/animationStates.generated.json)
- [文件夹及编号解析](https://github.com/Li-Rui-Zhe/BytePet/blob/8433f2d754f19df5bbcf0833a9271479d86e3754/src/systems/animation/frameResolver.ts)
- [实际资源导入校验](https://github.com/Li-Rui-Zhe/BytePet/blob/8433f2d754f19df5bbcf0833a9271479d86e3754/src-tauri/src/resources/mod.rs)

## 来源与重建

原始 PNG 来源是原项目 `public/assets/skins/rick_default/{calm,happy,run_right}/`。项目原 MIT 许可证随案例保留在 `web/static/examples/bytepet/LICENSE.txt`。来源文件与原始 SHA-256 记录于 `example.json` 的 `source_files`、`sha256`；开心派生文件的校验值为 `derived_sha256`，`original_frame_files` 指向保留的原始帧，`source_kind: repaired` 明确区分优化版。该许可证只说明 BytePet 案例来源，不替代帧的么自身的许可证。

使用固定公开提交重新构建：

```bash
python tools/build_bytepet_example.py
```

下载缓存存放在当前项目的 `.runtime/references/bytepet-files/`，在现有工作区中位于 D 盘。日常运行工作台不需要访问 GitHub，不依赖本机是否安装 BytePet。本案例不访问 BytePet 的数据库、API 密钥或用户配置。


## 按工具区分演示

序列帧切割使用透明帧拼接的长条。批量命名使用对应独立 PNG（开心为同一优化版），默认改为 asset_0001.png 等连续编号，保留图像像素。背景移除使用原工具保存的 star_uploaded_input.png 和 comfort_0001_uploaded_input.png 两张绿幕原图，来源与 SHA-256 单独记录，不冒充 BytePet 公开仓库文件。载入案例保持当前工具。

开心优化版母版、最终 imagegen Prompt 与重建说明见 [优化素材记录](../../web/static/examples/bytepet/curated/happy-v2/README.md)。重建原始案例会保留现有优化版配置。

原始绿幕示例的重新打包可运行 python -m tools.build_tool_examples；它依赖本机 assets 中的原始上传文件。日常使用只读取已打包示例，不需要原素材目录。
