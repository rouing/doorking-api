/**
 * @module src/markdown
 *
 * Turns the user guide (docs/MANUAL.md) into HTML for the /help page via marked + github-slugger.
 * Raw HTML in the source is escaped, and links are restricted to #anchors and http(s) URLs.
 */
import { Marked, type Tokens } from 'marked';
import GithubSlugger from 'github-slugger';

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const plain = (text: string): string => text.replace(/\*\*|`|\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

function createMarked(): Marked {
  const slugger = new GithubSlugger();
  return new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag): string {
        return /^<!--[\s\S]*-->$/.test(text.trim()) ? '' : esc(text);
      },
      heading({ tokens, depth, text }: Tokens.Heading): string {
        const id = slugger.slug(plain(text));
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      link({ href, tokens, raw }: Tokens.Link): string {
        if (!href || !/^(#[\w-]*|https?:\/\/[^\s)]+)$/.test(href)) return esc(raw);
        const target = href.startsWith('#') ? '' : ' target="_blank" rel="noopener"';
        return `<a href="${esc(href)}"${target}>${this.parser.parseInline(tokens)}</a>`;
      },
      image({ href, text, raw }: Tokens.Image): string {
        if (!href || !/^(https?:\/\/[^\s)]+|\/[^\s)]+)$/.test(href)) return esc(raw);
        return `<img src="${esc(href)}" alt="${esc(text)}">`;
      },
    },
  });
}

/**
 * Inline markup of one line or paragraph.
 *
 * @param text - Input text string.
 * @returns `string` result.
 */
export function inline(text: string): string {
  return createMarked().parseInline(text, { async: false });
}

/**
 * The guide's HTML body (no <html> wrapper).
 *
 * @param markdown - Markdown source text.
 * @returns `string` result.
 */
export function markdownToHtml(markdown: string): string {
  return createMarked().parse(markdown, { async: false }).trim();
}

/**
 * The whole /help page: the guide with its own styles (light and dark).
 *
 * @param markdown - Markdown source text.
 * @returns `string` result.
 */
export function helpPage(markdown: string, title = 'User guide · DoorKing Gate Manager'): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #60646c; --line: #d9d9e0; --bg: #fff; --soft: #f4f4f6; --accent: #3e63dd; }
@media (prefers-color-scheme: dark) { :root { --fg: #ededef; --muted: #a0a0ab; --line: #3a3a40; --bg: #111113; --soft: #1c1c20; --accent: #8da4ef; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 20px 64px; }
h1 { font-size: 1.9em; margin-top: 0.4em; } h2 { margin-top: 2em; padding-top: 0.6em; border-top: 1px solid var(--line); } h3 { margin-top: 1.6em; }
a { color: var(--accent); } code { background: var(--soft); padding: 0 4px; border-radius: 4px; font-size: 0.92em; }
pre { background: var(--soft); padding: 10px 14px; border-radius: 6px; overflow-x: auto; } pre code { padding: 0; background: none; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 0.95em; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; } th { background: var(--soft); }
blockquote { margin: 16px 0; padding: 4px 16px; border-left: 4px solid #e5484d; background: var(--soft); border-radius: 0 6px 6px 0; }
li { margin: 4px 0; }
</style></head><body><main>
${markdownToHtml(markdown)}
</main></body></html>`;
}
