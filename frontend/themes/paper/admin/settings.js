(function () {
  const select = document.getElementById('paper-doc'), raw = document.getElementById('paper-json'), note = document.getElementById('paper-note');
  const paths = { reading: '/api/admin/themes/paper/config/reading', site: '/api/admin/settings/site', themes: '/api/admin/themes', categories: '/api/admin/gallery/categories' };
  const activityFields = { enabled: 'paper-activity-enabled', title: 'paper-activity-title', days: 'paper-activity-days', timezone: 'paper-activity-timezone', 'github.enabled': 'paper-activity-github-enabled', 'github.title': 'paper-activity-github-title' };
  let documentValue, path, dirty = false, busy = false, documentKey = select.value;
  const fields = { accent: 'paper-accent', readingWidth: 'paper-width', fontSize: 'paper-size', heading: 'paper-heading', subtitle: 'paper-subtitle', showGallery: 'paper-gallery' };
  async function load() {
    documentKey = select.value; path = paths[select.value]; documentValue = await window.Mob.api(path); raw.value = JSON.stringify(documentValue.value, null, 2); document.getElementById('paper-refs').value = (documentValue.mediaIds || []).join(', '); dirty = false;
    document.getElementById('paper-controls').hidden = select.value !== 'reading';
    document.getElementById('paper-activity-controls').hidden = select.value !== 'site';
    if (select.value === 'site' && documentValue.value.activity) Object.entries(activityFields).forEach(([key, id]) => { const input = document.getElementById(id), value = key.split('.').reduce((value, part) => value[part], documentValue.value.activity); if (input.type === 'checkbox') input.checked = value; else input.value = value; });
    if (select.value === 'reading') Object.entries(fields).forEach(([key, id]) => { const input = document.getElementById(id), value = key === 'heading' || key === 'subtitle' ? documentValue.value.intro[key] : documentValue.value[key]; if (input.type === 'checkbox') input.checked = value; else input.value = value; });
    note.textContent = select.value === 'themes' ? '主题注册修改需要等待部署。' : '当前配置来自 GitHub。';
  }
  Object.entries(fields).forEach(([key, id]) => document.getElementById(id).addEventListener('input', event => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.type === 'number' ? Number(event.target.value) : event.target.value;
    try { const config = JSON.parse(raw.value); if (['heading', 'subtitle'].includes(key)) config.intro[key] = value; else config[key] = value; raw.value = JSON.stringify(config, null, 2); dirty = true; } catch { note.textContent = '请先修正 JSON，再使用外观表单。'; }
  }));
  Object.entries(activityFields).forEach(([key, id]) => document.getElementById(id).addEventListener('input', event => {
    try { const config = JSON.parse(raw.value); if (!config.activity) throw new Error(); let value = config.activity; const parts = key.split('.'); for (const part of parts.slice(0, -1)) value = value[part]; value[parts.at(-1)] = event.target.type === 'checkbox' ? event.target.checked : event.target.type === 'number' ? Number(event.target.value) : event.target.value; raw.value = JSON.stringify(config, null, 2); dirty = true; } catch { note.textContent = '请先在公共配置 JSON 中声明 activity，并修正 JSON。'; }
  }));
  select.addEventListener('change', () => { if (dirty && !confirm('放弃未保存的修改并切换？')) { select.value = documentKey; return; } load().catch(error => { note.textContent = error.message; }); });
  raw.addEventListener('input', () => { dirty = true; });
  document.getElementById('paper-save').addEventListener('click', async () => {
    if (busy) return; busy = true;
    try { const mediaIds = document.getElementById('paper-refs').value.split(/[,，]/).map(id => id.trim()).filter(Boolean); documentValue = await window.Mob.api(path, { method: 'PUT', json: { sha: documentValue.sha, value: JSON.parse(raw.value), mediaIds } }); dirty = false; note.textContent = '已写回仓库。提交 ' + documentValue.commitSha.slice(0, 8) + (select.value === 'themes' ? '，等待部署完成。' : '。'); }
    catch (error) { note.textContent = error.code === 'CONFIG_CONFLICT' ? '仓库配置已变化。页面保留了你的修改，请复制后重新加载合并。' : error.message; }
    finally { busy = false; }
  });
  document.getElementById('paper-file').addEventListener('change', event => {
    const file = event.target.files[0]; if (!file) return;
    const row = document.createElement('p'), retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.hidden = true; document.getElementById('paper-uploads').append(row, retry);
    const task = window.Mob.uploadTask(file, 'theme', (percent, stage) => { row.textContent = stage + ' ' + percent + '%'; });
    async function run() { busy = true; retry.hidden = true; try { const record = await task(); row.textContent = '已上传：' + record.url + '（填入配置并保存后生效）'; } catch (error) { row.textContent = error.message; retry.hidden = false; } finally { busy = false; } }
    retry.addEventListener('click', run); run();
  });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  load().catch(error => { note.textContent = error.message; });
})();
