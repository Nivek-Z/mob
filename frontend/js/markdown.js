(function () {
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      const named = { "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" };
      return "&" + named[char] + ";";
    });
  }
  function safeUrl(value) {
    const text = String(value || "").trim();
    if (text.charAt(0) === "/" && text.charAt(1) !== "/") return text;
    try {
      const url = new URL(text);
      if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    } catch (error) {}
    return "";
  }
  function inline(value) {
    return escapeHtml(value)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, alt, href) {
        const url = safeUrl(href);
        return url ? '<img alt="' + alt + '" src="' + escapeHtml(url) + '">' : escapeHtml(alt);
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, label, href) {
        const url = safeUrl(href);
        return url ? '<a href="' + escapeHtml(url) + '">' + label + "</a>" : label;
      })
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  }
  function renderMarkdown(source) {
    const blocks = [];
    const text = String(source || "").replace(/```([\s\S]*?)```/g, function (_, code) {
      blocks.push("<pre><code>" + escapeHtml(code.replace(/^\n|\n$/g, "")) + "</code></pre>");
      return "\n@@BLOCK" + (blocks.length - 1) + "@@\n";
    });
    const html = [];
    let list = "";
    let items = [];
    let paragraph = [];
    function closeList() {
      if (!list) return;
      html.push("<" + list + ">" + items.join("") + "</" + list + ">");
      list = "";
      items = [];
    }
    function closeParagraph() {
      if (!paragraph.length) return;
      html.push("<p>" + inline(paragraph.join(" ")) + "</p>");
      paragraph = [];
    }
    text.split(/\r?\n/).forEach(function (line) {
      const block = /^@@BLOCK(\d+)@@$/.exec(line.trim());
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      const item = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(line);
      if (block) { closeParagraph(); closeList(); html.push(blocks[Number(block[1])] || ""); return; }
      if (!line.trim()) { closeParagraph(); closeList(); return; }
      if (/^---+$/.test(line.trim())) { closeParagraph(); closeList(); html.push("<hr>"); return; }
      if (heading) {
        closeParagraph(); closeList();
        const level = heading[1].length + 1;
        html.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
        return;
      }
      if (line.charAt(0) === ">") {
        closeParagraph(); closeList();
        html.push("<blockquote><p>" + inline(line.replace(/^>\s?/, "")) + "</p></blockquote>");
        return;
      }
      if (item) {
        closeParagraph();
        const kind = item[2] === "-" || item[2] === "*" ? "ul" : "ol";
        if (list && list !== kind) closeList();
        list = kind;
        items.push("<li>" + inline(item[3]) + "</li>");
        return;
      }
      closeList();
      paragraph.push(line.trim());
    });
    closeParagraph();
    closeList();
    return html.join("\n");
  }
  window.Mob = window.Mob || {};
  window.Mob.renderMarkdown = renderMarkdown;
  window.Mob.escapeHtml = escapeHtml;
})();
