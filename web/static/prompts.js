'use strict';

(() => {
  const $ = selector => document.querySelector(selector);
  const examples = {
    chibi: {
      source: '动作帧模板q版', layout: 'strip',
      character: '一个圆润可爱的白色小机器人，蓝色发光面屏，小小的天线，短小四肢，胸前有蓝色爱心标记。保持大头小身体的 Q 版比例、白蓝配色和极简细节。',
      action: '平静待机，轻轻呼吸并眨眼',
      motion: '第1帧：自然站立，双眼睁开。\n第2帧：身体轻轻上浮，开始吸气。\n第3帧：吸气到最高点，轻轻闭眼。\n第4帧：身体慢慢回落，保持闭眼。\n第5帧：缓缓睁眼，回到原高度。\n第6帧：回到第1帧的自然站姿，便于循环衔接。',
      props: '不添加衣服或多余配饰，不增加复杂细节。',
      style: '保持圆润、可爱、轻微 3D 光泽感；画面简洁，适合表情包、贴纸、游戏角色或桌宠素材。',
    },
    realistic: {
      source: '动作帧模板写实', layout: 'strip',
      character: '黑衣修仙剑修风格的年轻男性，偏写实的国风漫画风。苍白清秀的面容，五官锐利、神情清冷克制。长黑发半束高马尾，头顶小发髻，其余头发自然披散，两侧少量碎发。身形高挑修长，穿黑色宽袖外袍与灰白色交叠内袍，黑色宽腰封、黑色简洁靴鞋，腰间佩简洁黑鞘长剑。整体保持黑、灰、灰白低饱和冷色调，不增加繁复花纹和配饰。',
      action: '安静站立，环顾左右，轻扶剑柄并微微拔剑，再收剑归位',
      motion: '第1帧：安静站立，佩剑在腰间。\n第2帧：头部轻轻转向左侧。\n第3帧：自然转向右侧，右手开始靠近剑柄。\n第4帧：右手握住剑柄，微微拔出一小段。\n第5帧：缓缓将剑收回剑鞘。\n第6帧：手臂与头部回归初始站姿，便于循环。',
      props: '腰间佩剑必须完整显示。剑的长度、样式、大小、角度与位置关系保持稳定，不漂移、不弯曲、不忽长忽短。袖口、头发和衣摆的变化必须连续合理；不要拔剑特效、夸张飘带或空气透视。',
      style: '简化的偏写实国风漫画角色立绘，保留辨识度，减少插画细节；保持清冷克制的气质，线条、结构与上色方式在六帧中完全统一。',
    },
    natasha: {
      source: '娜塔莎具体动作帧prompt', layout: 'strip',
      character: '这是一个深棕色皮肤的 Q 版婴儿/玩偶风角色，超大圆润的光头，脸部极简，闭着眼睛，眼睛是两条短短的黑色横线，嘴巴是非常显眼的荧光粉色嘟嘟唇，身体短小圆润，下身穿紫色小裤衩。必须完整保留角色的光头、闭眼、粉色嘴唇、深棕色皮肤、紫色裤衩和圆润比例。',
      action: '打哈欠',
      motion: '第1帧：闭眼自然站立，保持粉色嘟嘟唇。\n第2帧：头部轻轻后仰，嘴巴开始张开。\n第3帧：嘴巴张得更大，身体略微伸展。\n第4帧：哈欠达到最大幅度，保持光头、闭眼与嘴唇辨识度。\n第5帧：缓缓闭嘴，头部与身体放松回落。\n第6帧：恢复第1帧的闭眼站姿，平顺循环。',
      props: '不要添加衣服或配饰，不要改变紫色小裤衩、肤色、闭眼特征和荧光粉色嘴唇。',
      style: '圆润可爱、轻微 3D 光泽感的玩偶风，保持简洁稳定的动画素材感。',
    },
  };
  let selected = 'chibi';
  const drafts = new Map();
  const fields = ['character', 'action', 'motion', 'props', 'layout'];
  function values() { return Object.fromEntries(fields.map(key => [key, $('#prompt-' + key).value])); }
  function render() {
    const data = values(), example = examples[selected];
    const strip = data.layout === 'strip';
    const output = strip
      ? '创建一张六帧横向动画长条图，从左到右正好 6 个等宽区域。整张图目标尺寸 3072×512，每帧 512×512。只输出一张完整长条，不要输出六张独立图片。'
      : '请生成正好 6 张独立图片，每张目标尺寸 512×512、1:1 正方形，每张只绘制一个角色。按第1帧到第6帧的动作顺序输出，不要拼接成长条，不要多格漫画，不要把六帧画在同一张图中。';
    $('#prompt-output').value = `使用所附/参考图片作为唯一的严格角色参考，必须完全保留相同的角色形象、身材比例、面部布局、标志性特征、主色调和整体风格。不要重新设计，不要添加新设定，不要改变核心识别特征。

角色外观要求：
${data.character.trim() || example.character}

输出形式：
${output}

动作主题：
${data.action.trim() || example.action}

六帧动作节奏：
${data.motion.trim() || example.motion}

统一要求：
- 六帧必须是同一角色的连续动作，相邻帧变化明确但不能跳跃，首尾姿态自然衔接，适合循环动画。
- 每帧角色缩放比例和全身大小一致，居中对齐，保持相同的底部锚点与小边距，顶部和底部留出安全空间。
- 每帧必须完整显示全身；头发、手脚、服装与道具不能被截断，不能超出各自帧区域。
- 不出现角色长相漂移，不改变发型、服装结构、配色、道具样式、线条语言或上色方式。
- 整张图片背景必须为完全均匀的纯色 #33ff00 绿幕，不要渐变、纹理或透明棋盘格。角色内部不能出现绿色。
- 不要文字、边框、网格线、帧编号、水印。
- 不要速度线、运动轨迹线、漂浮符号、复杂特效、地面、投影或场景背景。
- 边缘清晰干净，轮廓明确，便于后续去背景与动画拆分。

风格要求：
${example.style}${data.props.trim() ? '\n\n道具与额外要求：\n' + data.props.trim() : ''}`;
    $('#prompt-count').textContent = $('#prompt-output').value.length + ' 字';
    $('#prompt-current-name').textContent = { chibi: 'Q 版角色', realistic: '写实 / 国风角色', natasha: '娜塔莎 · 打哈欠' }[selected];
    $('#prompt-current-format').textContent = strip ? '六帧长条 · 适合 GIF' : '六张独立图 · 适合 PNG 序列';
    $('#prompt-generation-hint').textContent = strip ? '一次生成 1 张图，里面包含 6 帧连续动作。' : '当前选择：生成 6 张独立图片，用于 PNG 序列。';
    $('#prompt-processing-hint').textContent = strip ? '把长条切成 6 张，去底后导出 GIF 或 PNG。' : '六张图片直接去底，打包下载 PNG 序列。';
    $('#prompt-short-description').textContent = data.action.trim() || example.action;
    $('#prompt-source').textContent = '整理自作者《' + example.source + '》；可切换输出形式。';
    const link = $('#prompt-process-link');
    link.href = strip ? '/editor?tool=split&format=gif&recipe=strip' : '/editor?tool=cutout&format=zip&recipe=images';
    link.textContent = strip ? '已生成长条，去切帧与去底 →' : '已生成六张图，去除背景 →';
    $('#prompt-process-hint').textContent = '上传后自动应用：' + (strip ? '横向 6 帧 · #33ff00 去底 · 512 px · 4 FPS' : '#33ff00 去底 · 512 px · PNG 图片 ZIP') + '。已有素材会保留，请按需移除后上传新图。';
    $('#copy-prompt').disabled = false;
    $('#copy-status').textContent = '复制时会带上完整角色、动作与输出要求。请同时在生图工具中附上参考图。';
  }
  function load(key, reset = false) {
    if (!reset && selected !== key) drafts.set(selected, values());
    selected = key;
    const data = reset ? examples[key] : drafts.get(key) || examples[key];
    fields.forEach(field => { $('#prompt-' + field).value = data[field]; });
    document.querySelectorAll('[data-template]').forEach(button => { const active = button.dataset.template === key; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); });
    render();
  }
  $('#prompt-form').addEventListener('submit', event => event.preventDefault());
  $('#prompt-form').addEventListener('input', render);
  document.querySelectorAll('[data-template]').forEach(button => button.addEventListener('click', () => load(button.dataset.template)));
  $('#reset-prompt').addEventListener('click', () => { drafts.delete(selected); load(selected, true); });
  function selectAll() { $('#prompt-details').open = true; const field = $('#prompt-output'); field.focus(); field.select(); }
  $('#select-prompt').addEventListener('click', () => { selectAll(); $('#copy-status').textContent = '已选中全文，按 Ctrl / ⌘ + C 复制。'; });
  $('#copy-prompt').addEventListener('click', async () => {
    const button = $('#copy-prompt'), text = $('#prompt-output').value;
    button.disabled = true;
    try {
      try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(text); }
      catch { selectAll(); if (!document.execCommand('copy')) throw new Error(); }
      $('#copy-status').textContent = '已复制完整 Prompt。去生图工具粘贴，并附上角色参考图。';
    } catch { selectAll(); $('#copy-status').textContent = '浏览器未允许自动复制，已选中全文，请按 Ctrl / ⌘ + C。'; }
    finally { button.disabled = false; }
  });
  load(selected);
})();
