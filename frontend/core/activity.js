(function () {
  const roots = [...document.querySelectorAll('[data-github-activity]')];
  if (!roots.length) return;
  let busy = false;
  const node = (tag, className, text) => { const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const number = value => new Intl.NumberFormat('zh-CN').format(value);
  function frame(root, title) {
    root.hidden = false; root.replaceChildren();
    const heading = node('div', 'activity-heading');
    const intro = node('div', 'activity-intro'); intro.append(node('p', 'activity-eyebrow', 'REPOSITORY / ACTIVITY'));
    const h2 = node('h2', 'activity-title', title); h2.id = root.id + '-title'; root.setAttribute('aria-labelledby', h2.id); intro.append(h2); heading.append(intro); root.append(heading);
    return heading;
  }
  function failed(root, title, message) {
    frame(root, title); root.append(node('p', 'activity-notice', message));
    const retry = node('button', 'activity-retry', '重新读取'); retry.type = 'button'; retry.addEventListener('click', load); root.append(retry);
  }
  function render(root, data) {
    if (!data.enabled || data.github.status === 'disabled') { root.hidden = true; root.replaceChildren(); return; }
    const source = data.github, heading = frame(root, data.title);
    const link = node('a', 'activity-repository', source.repository + ' ↗');
    const url = new URL(source.url); if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error('Invalid repository URL');
    link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; heading.append(link);
    root.append(node('p', 'activity-context', source.title + ' · ' + source.branch + ' · ' + data.range.from + ' — ' + data.range.to + ' · ' + data.timezone));
    if (source.status === 'unavailable') { root.append(node('p', 'activity-notice', '暂时无法读取仓库提交活动。')); const retry = node('button', 'activity-retry', '重新读取'); retry.type = 'button'; retry.addEventListener('click', load); root.append(retry); return; }
    if (!['ok', 'stale'].includes(source.status) || !Array.isArray(source.daily) || !source.stats) throw new Error('Invalid activity');
    root.classList.toggle('is-stale', source.status === 'stale');
    if (source.status === 'stale') root.append(node('p', 'activity-notice', '上次同步的数据 · 当前未能更新，请留意下方更新时间。'));
    const scroll = node('div', 'activity-scroll'), chart = node('div', 'activity-chart'); scroll.append(chart);
    const first = new Date(source.daily[0].date + 'T00:00:00Z').getUTCDay();
    const weeks = Math.ceil((first + source.daily.length) / 7);
    chart.style.setProperty('--activity-weeks', weeks);
    const months = node('div', 'activity-months');
    const labels = source.daily.flatMap((day, index) => index === 0 || day.date.slice(8) === '01' ? [{ column: Math.floor((index + first) / 7), month: Number(day.date.slice(5, 7)) }] : []);
    labels.forEach((label, index) => { if (labels[index + 1] && labels[index + 1].column - label.column < 3) return; const text = node('span', '', label.month + '月'); text.style.gridColumn = String(label.column + 1); months.append(text); });
    chart.append(months);
    const weekdays = node('div', 'activity-weekdays'); weekdays.setAttribute('aria-hidden', 'true');
    ['', '一', '', '三', '', '五', ''].forEach(text => weekdays.append(node('span', '', text))); chart.append(weekdays);
    const calendar = node('div', 'activity-calendar'); calendar.setAttribute('role', 'group'); calendar.setAttribute('aria-label', '每日提交次数，使用方向键查看日期');
    chart.append(calendar);
    const detail = node('p', 'activity-detail', '选择方块查看提交次数，方向键可切换日期。'); detail.setAttribute('role', 'status'); detail.setAttribute('aria-live', 'polite');
    let current = source.daily.length - 1;
    const buttons = source.daily.map((day, index) => {
      const cell = node('button', 'activity-cell'); cell.type = 'button'; cell.dataset.date = day.date;
      cell.dataset.level = String(day.count === 0 ? 0 : Math.max(1, Math.ceil(day.count / source.stats.peakDaily * 4)));
      cell.style.gridColumn = String(Math.floor((first + index) / 7) + 1); cell.style.gridRow = String((first + index) % 7 + 1);
      cell.title = day.date + ' · ' + number(day.count) + ' 次提交'; cell.setAttribute('aria-label', cell.title); cell.setAttribute('aria-pressed', 'false'); cell.tabIndex = index === current ? 0 : -1;
      const select = () => { buttons[current].tabIndex = -1; buttons[current].setAttribute('aria-pressed', 'false'); current = index; cell.tabIndex = 0; cell.setAttribute('aria-pressed', 'true'); detail.textContent = cell.title; };
      cell.addEventListener('click', select); cell.addEventListener('focus', select);
      cell.addEventListener('keydown', event => {
        const row = (index + first) % 7;
        const target = event.key === 'ArrowLeft' ? index - 7 : event.key === 'ArrowRight' ? index + 7 : event.key === 'ArrowUp' && row > 0 ? index - 1 : event.key === 'ArrowDown' && row < 6 ? index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
        if (event.key.startsWith('Arrow') || target !== null) event.preventDefault();
        if (target !== null && target >= 0 && target < buttons.length) { buttons[target].focus({ preventScroll: true }); buttons[target].scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
      });
      calendar.append(cell); return cell;
    });
    root.append(scroll);
    const legend = node('div', 'activity-legend'); legend.append(node('span', '', '少'));
    for (let level = 0; level < 5; level++) { const cell = node('span', 'activity-cell'); cell.dataset.level = level; cell.setAttribute('aria-hidden', 'true'); legend.append(cell); }
    legend.append(node('span', '', '多')); root.append(legend, detail);
    const stats = node('dl', 'activity-stats');
    [['区间提交', source.stats.total, '次'], ['活跃天数', source.stats.activeDays, '天'], ['单日最高', source.stats.peakDaily, '次'], ['最长连续', source.stats.longestStreakDays, '天'], ['当前连续', source.stats.currentStreakDays, '天']].forEach(([label, value, unit]) => {
      const item = node('div', 'activity-stat'); item.append(node('dd', '', number(value) + ' ' + unit), node('dt', '', label)); stats.append(item);
    }); root.append(stats);
    const time = new Intl.DateTimeFormat('zh-CN', { timeZone: data.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(source.updatedAt));
    root.append(node('p', 'activity-updated', '同步于 ' + time + ' · 仅统计此仓库绑定分支的提交，包含合并提交。'));
    scroll.scrollLeft = scroll.scrollWidth;
  }
  async function load() {
    if (busy) return; busy = true;
    roots.forEach(root => { root.setAttribute('aria-busy', 'true'); root.querySelectorAll('.activity-retry').forEach(button => { button.disabled = true; }); });
    try { const data = await window.Mob.api('/api/activity'); roots.forEach(root => render(root, data)); }
    catch { roots.forEach(root => failed(root, window.Mob.site?.activity?.title || '代码足迹', '暂时无法读取仓库提交活动，请稍后重试。')); }
    finally { busy = false; roots.forEach(root => root.setAttribute('aria-busy', 'false')); }
  }
  load();
})();
