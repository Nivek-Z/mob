(function () {
  async function api(path, options) {
    const settings = options || {};
    const headers = new Headers(settings.headers || {});
    let body = settings.body;
    if (settings.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(settings.json);
    }
    const response = await fetch(path, {
      method: settings.method || "GET",
      headers: headers,
      body: body,
      credentials: "same-origin"
    });
    const type = response.headers.get("Content-Type") || "";
    if (!type.includes("application/json")) {
      const error = new Error("请先打开 /admin/ 完成登录。");
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error((payload.error && payload.error.message) || "请求失败");
      error.status = response.status;
      error.code = payload.error && payload.error.code;
      error.details = payload.error && payload.error.details;
      throw error;
    }
    return payload.data;
  }
  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return date.getUTCFullYear() + "-" + month + "-" + day;
  }
  async function publishedPosts(extra) {
    const items = [];
    let offset = 0;
    let total = 0;
    const query = extra || {};
    while (offset <= 500) {
      const params = new URLSearchParams(query);
      params.set("limit", "100");
      params.set("offset", String(offset));
      const page = await api("/api/posts?" + params.toString());
      total = page.total;
      items.push.apply(items, page.items);
      if (items.length >= total || !page.items.length) break;
      offset += page.limit || 100;
    }
    return { items: items, total: total };
  }
  window.Mob = {
    api: api,
    formatDate: formatDate,
    publishedPosts: publishedPosts,
    name: "Nivek",
    line: "把做过的事写下来。"
  };
})();
