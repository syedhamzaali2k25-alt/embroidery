import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { AccountControl } from "./AccountMenu";
import { Icon } from "./Icon";

/** Top bar shared by the Upload and Preview screens: brand, the two steps, and actions. */
export function FlowBar({ step, children }: { step: 1 | 2; children?: ReactNode }) {
  return (
    <header className="flow-bar">
      <a className="brand" href="/home"><Icon name="logo" />Stitchbook</a>
      <ol className="flow-steps" aria-label="Steps">
        <li aria-current={step === 1 ? "step" : undefined}>
          {step === 1 ? <><span className="num">1</span>Upload</> : <Link to="/upload"><span className="num">1</span>Upload</Link>}
        </li>
        <li aria-current={step === 2 ? "step" : undefined}><span className="num">2</span>Preview</li>
      </ol>
      <div className="flow-bar__actions">{children}<AccountControl /></div>
    </header>
  );
}
