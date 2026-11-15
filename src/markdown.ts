import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => entities[character] ?? character);

function safeLink(href: string): boolean {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(href).protocol); }
  catch { return false; }
}

const markdown = new Marked({
  gfm: true,
  renderer: {
    // Notes are shared by peers: HTML is source text, never app markup.
    html: ({ text }) => escapeHtml(text),
    image: ({ text }) => `<span>[Image: ${escapeHtml(text)}]</span>`,
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!safeLink(href)) return label;
      return `<a href="${escapeHtml(href)}"${typeof title !== 'string' ? '' : ` title="${escapeHtml(title)}"`} target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  },
});

/** Render locally, without executing HTML or fetching embedded remote images. */
export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(markdown.parse(source, { async: false }), {
    ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'hr', 'a', 'span', 'input', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'type', 'disabled', 'checked', 'start', 'align'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
