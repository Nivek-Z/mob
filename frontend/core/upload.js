(function () {
  const types = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4' };
  function binary(path, blob, progress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open('PUT', path); xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.withCredentials = true;
      xhr.upload.onprogress = event => progress(event.loaded);
      xhr.onload = () => {
        let payload; try { payload = JSON.parse(xhr.responseText); } catch { reject(new Error('上传请求没有返回 JSON，请检查登录状态。')); return; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(payload.data);
        else reject(Object.assign(new Error(payload.error?.message || '上传失败'), { code: payload.error?.code }));
      };
      xhr.onerror = () => reject(new Error('网络中断，点击重试继续上传。')); xhr.send(blob);
    });
  }
  window.Mob.uploadTask = function (file, source, onProgress) {
    let session; let record; const completed = new Set();
    return async function run() {
      const name = file.name || 'pasted-image.png'; const contentType = types[name.split('.').pop().toLowerCase()] || file.type;
      if (!Object.values(types).includes(contentType)) throw new Error('支持 JPEG、PNG、GIF、WebP、AVIF、MP4、WebM、MP3、WAV、OGG 和 M4A。');
      const progress = onProgress || (() => {});
      if (!session) session = await window.Mob.api('/api/admin/uploads', { method: 'POST', json: { filename: name, contentType, size: file.size } });
      let base = '/api/admin/uploads/' + session.id;
      if (!record) {
        let state;
        try { state = await window.Mob.api(base); }
        catch (error) {
          const expired = Number.isFinite(Date.parse(session.expiresAt)) && Date.parse(session.expiresAt) <= Date.now();
          if (!['UPLOAD_EXPIRED', 'UPLOAD_NOT_FOUND'].includes(error.code) && !(error.code === 'UPLOAD_CLOSED' && expired)) throw error;
          // Session cleanup must not cause a second copy of an already completed file.
          try {
            const saved = await window.Mob.api('/api/admin/gallery/items', { method: 'POST', json: { id: session.id, source } });
            const item = saved.item;
            record = { id: item.id, key: 'media/' + item.id + '/' + item.filename, filename: item.filename,
              contentType: item.contentType, size: item.size, createdAt: item.createdAt, url: item.url };
          } catch (recoveryError) {
            if (recoveryError.code !== 'MEDIA_NOT_READY') throw recoveryError;
            session = await window.Mob.api('/api/admin/uploads', { method: 'POST', json: { filename: name, contentType, size: file.size } });
            completed.clear(); base = '/api/admin/uploads/' + session.id;
          }
          state = { status: record ? 'completed' : 'active', record };
        }
        if (state.status === 'completed' || state.record) record = state.record;
        if (!record && session.mode === 'single') record = await binary(base + '/body', file, loaded => progress(Math.round(loaded / file.size * 95), '上传到 R2'));
        else if (!record) {
          for (let number = 1; number <= session.partCount; number++) {
            if (completed.has(number)) continue;
            const start = (number - 1) * session.partSize;
            await binary(base + '/parts/' + number, file.slice(start, Math.min(start + session.partSize, file.size)), loaded => progress(Math.round((start + loaded) / file.size * 95), '上传分片'));
            completed.add(number);
          }
          record = await window.Mob.api(base + '/complete', { method: 'POST', json: {} });
        }
      }
      progress(97, '登记图库');
      await window.Mob.api('/api/admin/gallery/items', { method: 'POST', json: { id: record.id, source } });
      progress(100, '完成'); return record;
    };
  };
  window.Mob.bindDrops = function (box, accept) {
    box.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); box.classList.add('drop-active'); } });
    box.addEventListener('dragleave', () => box.classList.remove('drop-active'));
    box.addEventListener('drop', event => { box.classList.remove('drop-active'); if (event.dataTransfer?.files.length) { event.preventDefault(); accept(Array.from(event.dataTransfer.files)); } });
    box.addEventListener('paste', event => { const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); accept(files); } });
  };
})();
