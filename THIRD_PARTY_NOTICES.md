# 素材与第三方说明

FrameMe 代码采用根目录 [MIT License](LICENSE)。素材来源与处理情况如下。

| 内容 | 来源 | 说明 |
| --- | --- | --- |
| BytePet 原始透明帧 | [Li-Rui-Zhe/BytePet](https://github.com/Li-Rui-Zhe/BytePet)，固定提交 `8433f2d754f19df5bbcf0833a9271479d86e3754` | 保留原项目 [MIT 许可证](web/static/examples/bytepet/LICENSE.txt)，原始文件 SHA-256 见 `example.json` |
| calm / run_right 长条 | 上述原始 PNG 按顺序拼接 | 原帧像素保留，用于切割演示 |
| calm 预览 GIF | 上述原始帧制作 | 动画预览会做 GIF 调色板与透明度转换 |
| happy 优化版 | 基于 BytePet 开心动作的 AI 修补与重绘 | 补全天线，统一留白；与原始素材分目录保存，详见[制作记录](web/static/examples/bytepet/curated/happy-v2/README.md) |
| 纯色去底演示图 | 作者提供的插画与图标示例 | 仅打包两张指定演示图，不包含作者原始素材库或用户上传文件 |
| Q 版、写实与娜塔莎 Prompt | 作者编写并整理 | 已适配工作台流程，页面可复制与修改；模型输出仍需检查 |
| 品牌图标与装饰 | 项目内 SVG / CSS | 无第三方图标字体依赖 |
| README 截图 | 空工作区与内置演示专门生成 | 不使用个人历史任务、上传图片或账户数据 |

运行时只需要 Flask 与 Pillow，其各自许可随对应依赖分发。FrameMe 不包含生图模型，也不代理或分发生图服务；使用其他工具生成素材时，请遵守该工具和参考素材的使用条款。

BytePet 是本项目的关联应用与素材来源，FrameMe 也可独立用于 GIF、贴纸、游戏动画和其他图片素材工作流。
