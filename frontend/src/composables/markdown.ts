import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";

const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  }),
);

marked.use({
  renderer: {
    code(token) {
      const lang = token.lang ?? "plaintext";
      const html = hljs.getLanguage(lang)
        ? hljs.highlight(token.text, { language: lang }).value
        : escape(token.text);
      const safeText = escape(token.text);
      return `<div class="code-block" data-lang="${escape(lang)}">
        <div class="code-block__header">
          <span class="code-block__lang">${escape(lang)}</span>
          <button class="code-block__copy" data-copy="${safeText}" type="button">Copy</button>
        </div>
        <pre class="code-block__pre"><code class="hljs language-${escape(lang)}">${html}</code></pre>
      </div>`;
    },
    codespan(token) {
      return `<code class="inline-code">${escape(token.text)}</code>`;
    },
  },
});

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

export function bindCopyButtons(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>(".code-block__copy").forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      const text = btn.dataset.copy ?? "";
      const decoded = new DOMParser().parseFromString(text, "text/html").body.textContent ?? "";
      await navigator.clipboard.writeText(decoded);
      const original = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.textContent = original;
      }, 1200);
    });
  });
}
