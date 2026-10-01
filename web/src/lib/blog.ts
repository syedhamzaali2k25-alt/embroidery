// Blog posts: Markdown files in web/content/blog/ (the "@blog" alias, see vite.config.ts), read at
// build time. Files whose name starts with "_" (like _example.md, which documents the format) are
// never part of the site. Each file starts with frontmatter:
//
//   ---
//   title: The post's title
//   date: 2026-01-31
//   summary: One or two sentences for the list page.
//   ---
//   The post in Markdown...

const files = import.meta.glob(["@blog/*.md", "!@blog/_*.md"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export type Post = { slug: string; title: string; date: string; summary: string; body: string };

/** Split "---\nkey: value\n---\nbody" into its fields and the Markdown body. */
export function parsePost(slug: string, text: string): Post | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) fields[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  if (!fields.title || !fields.date) return null; // a post needs at least a title and a date
  return { slug, title: fields.title, date: fields.date, summary: fields.summary ?? "", body: match[2] };
}

/** Every post, newest first (by the date in its frontmatter, as written: YYYY-MM-DD sorts correctly). */
export const posts: Post[] = Object.entries(files)
  .map(([path, text]) => parsePost(path.split("/").pop()!.replace(/\.md$/, ""), text))
  .filter((p): p is Post => p !== null)
  .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug.localeCompare(b.slug)));

export const findPost = (slug: string | undefined) => posts.find((p) => p.slug === slug) ?? null;

// ---------- a small Markdown renderer ----------
// Supports what a post needs: # headings, paragraphs, - and 1. lists, > quotes, ``` code blocks,
// **bold**, *italic*, `code` and [links](https://...). All text is HTML-escaped first, and links
// may only go to http(s) addresses or to paths on this site.

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text: string): string {
  return escape(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) =>
      /^(https?:\/\/|\/(?!\/))/.test(href) ? `<a href="${href}">${label}</a>` : label);
}

export function renderMarkdown(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.max(2, heading[1].length); // the page title is the only h1: # and ## are h2, ### is h3
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    const list = /^(\s*)([-*]|\d+\.)\s+/;
    if (list.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && list.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(list, ""))}</li>`);
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) quote.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|>|\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}
