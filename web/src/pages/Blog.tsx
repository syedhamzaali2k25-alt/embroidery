// Blog list and post pages, from the Markdown files in web/content/blog/ (see src/lib/blog.ts).
import { Link, useParams } from "react-router-dom";

import { findPost, posts, renderMarkdown } from "../lib/blog";
import { SitePage } from "../lib/SiteChrome";
import { usePage } from "../lib/usePage";

export default function Blog() {
  usePage("Blog · Stitchbook", "site-page");
  return (
    <SitePage>
      <h1>Blog</h1>
      {posts.length === 0 ? (
        <p className="empty-state">No posts yet.</p>
      ) : (
        <ul className="post-list">
          {posts.map((p) => (
            <li key={p.slug}>
              <Link className="post-card" to={`/blog/${p.slug}`}>
                <span className="post-card__title">{p.title}</span>
                <span className="post-meta"><time dateTime={p.date}>{p.date}</time></span>
                {p.summary && <span className="post-card__summary">{p.summary}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SitePage>
  );
}

export function BlogPost() {
  const { slug } = useParams();
  const post = findPost(slug);
  usePage(post ? `${post.title} · Stitchbook` : "Post not found · Stitchbook", "site-page");
  if (!post) {
    return (
      <SitePage>
        <h1>Post not found</h1>
        <p className="doc__lede">There is no post at this address.</p>
        <p><Link to="/blog">All posts</Link></p>
      </SitePage>
    );
  }
  return (
    <SitePage>
      <p><Link to="/blog">All posts</Link></p>
      <article>
        <h1>{post.title}</h1>
        <p className="post-meta"><time dateTime={post.date}>{post.date}</time></p>
        <div className="post-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(post.body) }} />
      </article>
    </SitePage>
  );
}
