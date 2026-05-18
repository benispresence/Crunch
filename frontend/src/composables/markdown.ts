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

/**
 * Syntax-highlight a raw code string. Returns inner HTML (no <pre><code>).
 * Used by tool-call viewers and the proposal diff card.
 */
export function highlightCode(code: string, lang: string): string {
  if (!code) return "";
  const language = hljs.getLanguage(lang) ? lang : "plaintext";
  return hljs.highlight(code, { language }).value;
}

/**
 * Guess the most useful language for a given string. SQL keywords win over
 * Python, Python over generic JSON, and everything else falls through.
 */
export function guessLanguage(s: string): string {
  if (!s) return "plaintext";
  const trimmed = s.trim();
  if (/^\s*\{[\s\S]*\}\s*$|^\s*\[[\s\S]*\]\s*$/.test(trimmed)) return "json";
  if (/\b(SELECT|WITH|FROM|WHERE|JOIN|INSERT|UPDATE|DELETE|CREATE)\b/i.test(trimmed)) return "sql";
  if (/\b(import|def|class|print)\b/.test(trimmed) && /[:=]/.test(trimmed)) return "python";
  return "plaintext";
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
