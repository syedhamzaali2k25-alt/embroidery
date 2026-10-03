import { Link } from "react-router-dom";

import { FlowBar } from "../lib/FlowBar";
import { usePage } from "../lib/usePage";
import "../css/flow.css";
import { titled } from "../lib/brand";

export default function NotFound() {
  usePage(titled("Page not found"), "flow");
  return (
    <>
      <FlowBar step={1} />
      <main className="flow-main">
        <div className="flow-state">
          <p className="flow-state__title">This page doesn't exist</p>
          <p className="flow-state__text">Check the address, or start again from the upload page.</p>
          <div className="flow-state__actions"><Link className="btn btn--ink" to="/upload">Upload a logo</Link></div>
        </div>
      </main>
    </>
  );
}
