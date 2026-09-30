import { Link, useSearchParams } from "react-router-dom";

import { usePage } from "../lib/usePage";
import DesignEditor from "./DesignEditor";
import "../css/editor.css";

// With ?design=<id> the editor works on that design (DesignEditor). Without one there is
// nothing to edit: the page says how to get a design into the editor.
export default function Editor() {
  usePage("Stitchbook Editor", "editor");
  const [search] = useSearchParams();
  const designParam = search.get("design");
  const designId = designParam && /^[0-9a-f]{32}$/.test(designParam) ? designParam : null;
  if (designId) return <DesignEditor designId={designId} />;
  return (
    <>
      <header className="bar">
        <div className="bar__left">
          <a className="icon-btn" href="/home" aria-label="Back to designs"><svg aria-hidden="true"><use href="/assets/sprite.svg#i-back"/></svg></a>
          <div className="file">
            <p className="file__name">Editor</p>
            <p className="file__state">No design open</p>
          </div>
        </div>
      </header>
      <main className="editor-empty">
        <div className="stage__message">
          <h1 className="editor-empty__title">No design open</h1>
          <p>
            Upload a PNG or JPG logo, then choose "Fix stitches in the editor" on its preview. The editor opens
            that design.
          </p>
          <Link className="btn btn--ink" to="/upload">Upload a logo</Link>
        </div>
      </main>
    </>
  );
}
