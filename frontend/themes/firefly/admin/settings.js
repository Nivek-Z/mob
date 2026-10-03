(function () {
  const api = window.Mob.api; const select = document.getElementById('settings-document'); const root = document.getElementById('settings-fields'); const raw = document.getElementById('settings-json'); const note = document.getElementById('settings-note');
  const documents = { site: '/api/admin/settings/site', appearance: '/api/admin/themes/firefly/config/appearance', themes: '/api/admin/themes', categories: '/api/admin/gallery/categories' };
  const names = { title: '标题', description: '说明', profile: '个人资料', name: '名称', bio: '个人简介', avatar: '头像', socials: '社交链接', friends: '友链', navigation: '全站导航', label: '显示名称', url: '链接', hero: '首屏', eyebrow: '眉题', occupation: '身份描述', cover: '首屏封面', images: '展示图片', stickers: '贴纸', text: '文字', x: '横向位置 %', y: '纵向位置 %', rotation: '旋转角度', size: '大小 px', motion: '动效', enabled: '启用', rain: '雨幕', ticker: '滚动标语', heroScrollVh: '首屏滚动距离 vh', storyScrollVh: '故事滚动距离 vh', guide: '导航展示', introTitle: '介绍标题', introText: '介绍文案', journey: '旅程', wishes: '轮播祝福', heading: '章节标题', scenes: '故事章节', image: '图片', dialogue: '对话向导', welcome: '欢迎语', outro: '结尾', subtitle: '副标题', defaultTheme: '默认主题 ID', allowVisitorSwitch: '允许访客切换', themes: '主题列表', items: '分类', id: '唯一 ID', root: '目录', copy: '其他文字（CSS 选择器）', styles: '自定义样式（CSS 选择器 → 属性）' };
  let current, endpoint, dirty = false, saving = false, uploading = 0, documentKey = select.value;
  function syncRaw() { raw.value = JSON.stringify(current.value, null, 2); dirty = true; }
  function render() {
    root.replaceChildren();
    function field(value, path, parent, key) {
      if (value && typeof value === 'object') {
        const section = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = names[key] || key; section.append(legend); parent.append(section);
        Object.entries(value).forEach(([childKey, child]) => field(child, path.concat(childKey), section, childKey));
        if (Array.isArray(value) && !['scenes', 'themes'].includes(key)) {
          const add = document.createElement('button'); add.type = 'button'; add.textContent = '添加一项'; add.addEventListener('click', () => { const template = ['socials', 'friends', 'navigation'].includes(key) ? { label: '', url: '' } : key === 'stickers' ? { text: '✳', x: 50, y: 50, rotation: 0, size: 24 } : key === 'items' ? { id: 'new-category', name: '新分类' } : ''; value.push(template); syncRaw(); render(); }); section.append(add);
          Object.keys(value).forEach(index => { const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除第 ' + (Number(index) + 1) + ' 项'; remove.addEventListener('click', () => { value.splice(Number(index), 1); syncRaw(); render(); }); section.append(remove); });
        }
        return;
      }
      const label = document.createElement('label'); label.className = 'field'; label.append(document.createTextNode(names[key] || key));
      const input = document.createElement(typeof value === 'string' && value.length > 140 ? 'textarea' : 'input');
      input.type = typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : 'text'; input.step = 'any';
      if (input.type === 'checkbox') input.checked = value; else input.value = value ?? '';
      const set = value => { let node = current.value; for (const segment of path.slice(0, -1)) node = node[segment]; node[path.at(-1)] = value; syncRaw(); };
      input.addEventListener('input', () => set(input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value)); label.append(input); parent.append(label);
      if (typeof value === 'string' && (/avatar|cover|image/i.test(key) || value.startsWith('/theme-media/') || /\/media\//.test(value))) {
        const upload = document.createElement('input'); upload.type = 'file'; upload.accept = 'image/*,video/mp4,video/webm,audio/*'; const status = document.createElement('span'); label.append(upload, status);
        upload.addEventListener('change', () => { const file = upload.files[0]; if (!file) return; const task = window.Mob.uploadTask(file, 'theme', (percent, stage) => { status.textContent = stage + ' ' + percent + '%'; }); const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.hidden = true; label.append(retry);
          async function run() { retry.hidden = true; upload.disabled = true; uploading++; try { const record = await task(); input.value = record.url; set(record.url); status.textContent = '已上传，保存设置后生效'; } catch (error) { status.textContent = error.message; retry.hidden = false; } finally { upload.disabled = false; uploading--; } } retry.addEventListener('click', run); run(); });
      }
    }
    Object.entries(current.value).forEach(([key, value]) => field(value, [key], root, key));
  }
  async function load() { documentKey = select.value; endpoint = documents[select.value]; note.textContent = '正在读取仓库配置…'; current = await api(endpoint); raw.value = JSON.stringify(current.value, null, 2); document.getElementById('settings-refs').value = (current.mediaIds || []).join(', '); dirty = false; render(); note.textContent = select.value === 'themes' ? '主题注册变更会触发部署，部署完成后生效。' : '保存直接写回对应 GitHub 配置文件。'; }
  select.addEventListener('change', () => { if (dirty && !confirm('有未保存的配置，继续切换？')) { select.value = documentKey; return; } load().catch(error => { note.textContent = error.message; }); });
  raw.addEventListener('input', () => { dirty = true; });
  document.getElementById('settings-apply-json').addEventListener('click', () => { try { current.value = JSON.parse(raw.value); render(); dirty = true; note.textContent = 'JSON 已应用到表单，尚未保存。'; } catch { note.textContent = 'JSON 格式有误。'; } });
  document.getElementById('settings-save').addEventListener('click', async () => {
    if (saving || uploading || !current) return;
    saving = true; note.textContent = '正在提交配置…';
    try { const value = JSON.parse(raw.value); const mediaIds = document.getElementById('settings-refs').value.split(/[,，]/).map(id => id.trim()).filter(Boolean); const saved = await api(endpoint, { method: 'PUT', json: { sha: current.sha, value, mediaIds } }); current = { ...saved, mediaIds }; dirty = false; render(); note.textContent = '已保存。提交 ' + saved.commitSha.slice(0, 8) + (select.value === 'themes' ? '，等待部署完成。' : '，刷新前台即可读取。'); }
    catch (error) { note.textContent = error.code === 'CONFIG_CONFLICT' ? '配置已被修改，当前输入已保留。复制修改后重新加载再合并。' : error.message; }
    finally { saving = false; }
  });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  load().catch(error => { note.textContent = error.message; });
})();
