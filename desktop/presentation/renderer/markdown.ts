import { marked, type Tokens } from "marked";

marked.setOptions({ breaks: true, gfm: true });

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(input: string): string {
  return escapeHtml(input).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 仅放行 http(s)、mailto、相对路径与 # 锚点；其余协议（javascript:、data:、file: 等）一律降级为纯文本。
function isSafeUrl(raw: string): boolean {
  const href = (raw || "").trim().toLowerCase();
  if (!href) return false;
  if (href.startsWith("#")) return true;
  if (href.startsWith("http://") || href.startsWith("https://")) return true;
  if (href.startsWith("mailto:")) return true;
  if (href.startsWith("/") || href.startsWith("./") || href.startsWith("../")) return true;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(href)) return false;
  return true;
}

// 模型输出中的原始 HTML 标签统一转义，避免注入；Markdown 结构照常渲染。
marked.use({
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link({ href, title, text }: Tokens.Link) {
      if (!isSafeUrl(href ?? "")) {
        return `<span class="llm-md-blocked-link">${escapeHtml(text)}</span>`;
      }
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      return `<a href="${escapeAttr(href ?? "")}"${titleAttr} rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(text)}</a>`;
    },
    image({ href, title, text }: Tokens.Image) {
      if (!isSafeUrl(href ?? "")) {
        return escapeHtml(text);
      }
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      return `<img src="${escapeAttr(href ?? "")}"${titleAttr} alt="${escapeAttr(text)}" loading="lazy" />`;
    },
  },
});

let ready = false;
export function renderMarkdown(text: string): string {
  if (!text) return "";
  try {
    if (!ready) {
      console.info("[markdown] renderer ready (breaks+gfm, raw-html escaped, link/image href filtered)");
      ready = true;
    }
    const html = marked.parse(text);
    return typeof html === "string" ? html : escapeHtml(text);
  } catch (err) {
    console.warn("[markdown] parse failed, fallback to escaped text:", err);
    return escapeHtml(text);
  }
}
