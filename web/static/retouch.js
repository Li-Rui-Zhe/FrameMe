'use strict';

// Vector stroke history keeps undo small even for large original images.
class FrameMeRetouch {
  constructor(onSave) {
    this.onSave = onSave;
    this.dialog = document.querySelector('#retouch-dialog');
    this.canvas = document.querySelector('#retouch-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.viewport = document.querySelector('#retouch-viewport');
    this.cursor = document.querySelector('#retouch-cursor');
    this.$ = id => document.querySelector('#retouch-' + id);
    this.tool = 'erase';
    this.strokes = []; this.redo = [];
    this.saving = false; this.loaded = false;
    this.compare = false; this.generation = 0;
    this.$('size').addEventListener('input', () => { this.$('size-value').textContent = this.$('size').value + ' px'; });
    this.$('zoom').addEventListener('input', () => this.layout());
    this.$('fit').addEventListener('click', () => { this.$('zoom').value = '100'; this.layout(); this.viewport.scrollTo(0, 0); });
    this.$('undo').addEventListener('click', () => this.undo());
    this.$('redo').addEventListener('click', () => this.redoStroke());
    this.$('compare').addEventListener('click', () => { this.finish(); this.compare = !this.compare; this.paint(); this.controls(); });
    for (const button of this.dialog.querySelectorAll('[data-brush]')) button.addEventListener('click', () => {
      this.finish(); this.tool = button.dataset.brush; this.controls();
    });
    for (const id of ['close', 'cancel']) this.$(id).addEventListener('click', () => { if (!this.saving) this.dialog.close(); });
    this.dialog.addEventListener('cancel', event => { if (this.saving) event.preventDefault(); });
    this.dialog.addEventListener('close', () => {
      this.generation++; this.active = null; this.initial = null; this.original = null;
      this.loaded = false; this.strokes = []; this.redo = [];
      this.canvas.width = this.canvas.height = 1;
      this.cursor.hidden = true;
    });
    this.dialog.addEventListener('keydown', event => {
      if (this.saving || !this.loaded || ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        if (event.key.toLowerCase() === 'y' || event.shiftKey) this.redoStroke(); else this.undo();
      }
    });
    this.$('save').addEventListener('click', () => this.save());
    this.canvas.addEventListener('pointerdown', event => this.down(event));
    this.canvas.addEventListener('pointermove', event => this.move(event));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) this.canvas.addEventListener(type, event => {
      if (this.active?.pointerId === event.pointerId) this.finish();
    });
    this.canvas.addEventListener('pointerleave', () => { this.cursor.hidden = true; });
    new ResizeObserver(() => { if (this.loaded && this.dialog.open) this.layout(); }).observe(this.viewport);
  }

  async open({ image, original, name }) {
    const generation = ++this.generation;
    this.loaded = false; this.saving = false; this.compare = false; this.tool = 'erase';
    this.strokes = []; this.redo = []; this.active = null;
    this.canvas.width = this.canvas.height = 1;
    this.$('zoom').value = '100';
    this.$('status').textContent = '正在载入 ' + name + '…';
    this.controls();
    this.dialog.showModal();
    try {
      const load = url => new Promise((resolve, reject) => {
        const item = new Image();
        item.onload = () => resolve(item);
        item.onerror = () => reject(new Error('图片载入失败，请关闭后重试。'));
        item.src = url;
      });
      const [initial, reference] = await Promise.all([load(image), load(original)]);
      if (generation !== this.generation || !this.dialog.open) return;
      if (initial.naturalWidth !== reference.naturalWidth || initial.naturalHeight !== reference.naturalHeight) throw new Error('原图与结果尺寸不一致，无法修补。');
      this.initial = initial; this.original = reference;
      this.canvas.width = initial.naturalWidth; this.canvas.height = initial.naturalHeight;
      this.loaded = true;
      this.$('size').value = String(Math.max(1, Math.min(240, Math.round(initial.naturalWidth / 25))));
      this.$('size-value').textContent = this.$('size').value + ' px';
      this.layout(); this.paint(); this.controls();
    } catch (error) {
      if (generation === this.generation && this.dialog.open) this.$('status').textContent = error.message;
    }
  }

  layout() {
    if (!this.loaded) return;
    this.fit = Math.min((this.viewport.clientWidth - 50) / this.canvas.width, (this.viewport.clientHeight - 50) / this.canvas.height, 1);
    this.scale = Math.max(.01, this.fit) * Number(this.$('zoom').value) / 100;
    this.canvas.style.width = this.canvas.width * this.scale + 'px';
    this.canvas.style.height = this.canvas.height * this.scale + 'px';
    this.$('zoom-value').textContent = this.$('zoom').value + '%';
    this.cursor.hidden = true;
  }

  controls() {
    const disabled = !this.loaded || this.saving;
    for (const button of this.dialog.querySelectorAll('button, input')) button.disabled = disabled;
    this.$('close').disabled = this.$('cancel').disabled = this.saving;
    this.$('undo').disabled = disabled || !this.strokes.length || this.compare;
    this.$('redo').disabled = disabled || !this.redo.length || this.compare;
    this.$('save').disabled = disabled || !this.strokes.length || !!this.active;
    this.$('save').lastChild.textContent = this.saving ? ' 正在保存…' : ' 保存修补';
    this.$('compare').setAttribute('aria-pressed', String(this.compare));
    this.canvas.dataset.tool = this.tool;
    this.canvas.dataset.compare = String(this.compare);
    for (const button of this.dialog.querySelectorAll('[data-brush]')) {
      const selected = this.tool === button.dataset.brush;
      button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
    }
    this.cursor.hidden = true;
    if (this.loaded) this.$('status').textContent = this.saving ? '正在保存到工作区，请稍等…' : this.compare ? '正在查看原图，点击“对比原图”返回修补' : this.strokes.length ? '已修改 · ' + this.strokes.length + ' 笔，保存后应用到下载结果' : '拖动画笔开始修补 · Ctrl / ⌘ + Z 撤销';
  }

  point(event) {
    const box = this.canvas.getBoundingClientRect();
    return { x: (event.clientX - box.left) * this.canvas.width / box.width, y: (event.clientY - box.top) * this.canvas.height / box.height };
  }

  down(event) {
    if (!this.loaded || this.saving || this.compare || event.button !== 0 || this.active) return;
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    if (this.tool === 'pan') {
      this.active = { pointerId: event.pointerId, pan: true, x: event.clientX, y: event.clientY, left: this.viewport.scrollLeft, top: this.viewport.scrollTop };
    } else {
      this.active = { pointerId: event.pointerId, tool: this.tool, size: Number(this.$('size').value), points: [this.point(event)] };
      this.segment(this.active, this.active.points[0], this.active.points[0]);
    }
    this.controls();
  }

  move(event) {
    if (!this.loaded || this.saving || this.compare) return;
    if (this.active && this.active.pointerId !== event.pointerId) return;
    if (this.active?.pan) {
      this.viewport.scrollLeft = this.active.left - (event.clientX - this.active.x);
      this.viewport.scrollTop = this.active.top - (event.clientY - this.active.y);
      return;
    }
    if (this.tool !== 'pan') {
      const box = this.viewport.getBoundingClientRect();
      this.cursor.style.left = event.clientX - box.left + this.viewport.scrollLeft + 'px';
      this.cursor.style.top = event.clientY - box.top + this.viewport.scrollTop + 'px';
      this.cursor.style.width = this.cursor.style.height = Number(this.$('size').value) * this.scale + 'px';
      this.cursor.hidden = false;
    }
    if (!this.active) return;
    for (const sample of event.getCoalescedEvents?.().length ? event.getCoalescedEvents() : [event]) {
      const point = this.point(sample), prior = this.active.points[this.active.points.length - 1];
      if (Math.hypot(point.x - prior.x, point.y - prior.y) < .2) continue;
      this.segment(this.active, prior, point);
      this.active.points.push(point);
    }
  }

  segment(stroke, a, b) {
    // A capsule-shaped clip restores exact original RGBA, including original
    // transparency. It never paints opaque white into an erased area.
    const radius = stroke.size / 2, angle = Math.atan2(b.y - a.y, b.x - a.x);
    const dx = Math.sin(angle) * radius, dy = Math.cos(angle) * radius;
    const path = new Path2D();
    path.moveTo(a.x + dx, a.y - dy); path.lineTo(b.x + dx, b.y - dy);
    path.lineTo(b.x - dx, b.y + dy); path.lineTo(a.x - dx, a.y + dy); path.closePath();
    path.moveTo(a.x + radius, a.y); path.arc(a.x, a.y, radius, 0, Math.PI * 2);
    path.moveTo(b.x + radius, b.y); path.arc(b.x, b.y, radius, 0, Math.PI * 2);
    this.ctx.save(); this.ctx.clip(path);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (stroke.tool === 'restore') this.ctx.drawImage(this.original, 0, 0);
    this.ctx.restore();
  }

  finish() {
    if (!this.active) return;
    if (!this.active.pan) { this.strokes.push(this.active); this.redo = []; }
    const pointerId = this.active.pointerId;
    this.active = null;
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    this.controls();
  }

  paint() {
    if (!this.loaded) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(this.compare ? this.original : this.initial, 0, 0);
    if (this.compare) return;
    for (const stroke of this.strokes) {
      this.segment(stroke, stroke.points[0], stroke.points[0]);
      for (let i = 1; i < stroke.points.length; i++) this.segment(stroke, stroke.points[i - 1], stroke.points[i]);
    }
  }

  undo() {
    if (this.saving || this.compare || !this.strokes.length) return;
    this.finish(); this.redo.push(this.strokes.pop()); this.paint(); this.controls();
  }

  redoStroke() {
    if (this.saving || this.compare || !this.redo.length) return;
    this.finish(); this.strokes.push(this.redo.pop()); this.paint(); this.controls();
  }

  async save() {
    if (!this.loaded || this.saving || !this.strokes.length || this.active) return;
    this.compare = false; this.paint(); this.saving = true; this.controls();
    try {
      const blob = await new Promise(resolve => this.canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('无法生成修补图片，请重试。');
      await this.onSave(blob);
      this.saving = false; this.dialog.close();
    } catch (error) {
      this.saving = false; this.controls();
      this.$('status').textContent = '保存失败：' + (error.message || '请检查服务后重试，当前修补仍保留。');
    }
  }
}
