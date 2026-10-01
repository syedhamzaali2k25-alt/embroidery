import { useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

import { Icon } from "./Icon";
import "../css/fields.css";

// The one text-field component (styles: css/fields.css). A visible label above, the control in a
// bordered box, optional unit, helper text, and an error message with an icon that is announced
// (role="alert") and linked to the control (aria-describedby, aria-invalid). Never colour alone.

type Common = {
  label: ReactNode;
  /** Plain helper text under the field. */
  help?: ReactNode;
  /** An error message; turns the field into its error state. */
  error?: ReactNode;
  /** A confirmation shown with a check icon (only where there is one to give). */
  ok?: ReactNode;
  /** Unit shown inside the box, e.g. "mm". */
  unit?: string;
  /** 40px editor field instead of the 52px form field. */
  compact?: boolean;
  className?: string;
};

function describedBy(id: string, help: unknown, error: unknown, ok: unknown, extra?: string) {
  return [extra, error ? `${id}-error` : help ? `${id}-help` : null, ok && !error ? `${id}-ok` : null]
    .filter(Boolean).join(" ") || undefined;
}

function Messages({ id, help, error, ok }: { id: string; help?: ReactNode; error?: ReactNode; ok?: ReactNode }) {
  return (
    <>
      {error ? (
        <p className="fld__msg fld__msg--error" id={`${id}-error`} role="alert"><Icon name="i-alert" />{error}</p>
      ) : help ? <p className="fld__help" id={`${id}-help`}>{help}</p> : null}
      {ok && !error && <p className="fld__msg fld__msg--ok" id={`${id}-ok`}><Icon name="i-check" />{ok}</p>}
    </>
  );
}

const cls = (kind: string, { compact, error, className }: Common) =>
  ["fld", kind, compact && "fld--compact", error && "fld--error", className].filter(Boolean).join(" ");

/** A single-line text or number field. type="password" adds a Show / Hide button inside the box. */
export function TextField({ label, help, error, ok, unit, compact, className, id: givenId, type = "text", ...input }:
  Common & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const id = givenId ?? auto;
  const [shown, setShown] = useState(false);
  const password = type === "password";
  return (
    <div className={cls("fld--text", { label, compact, error, className })}>
      <label className="fld__label" htmlFor={id}>{label}</label>
      <div className="fld__box">
        <input {...input} id={id} type={password && shown ? "text" : type}
               aria-invalid={error ? true : undefined}
               aria-describedby={describedBy(id, help, error, ok, input["aria-describedby"])} />
        {unit && <span className="fld__unit" aria-hidden="true">{unit}</span>}
        {password && (
          <button className="fld__btn" type="button" aria-pressed={shown} aria-controls={id}
                  aria-label={shown ? "Hide password" : "Show password"} onClick={() => setShown((v) => !v)}
                  disabled={input.disabled}>
            <Icon name={shown ? "i-eye-off" : "i-eye"} />
          </button>
        )}
      </div>
      <Messages id={id} help={help} error={error} ok={ok} />
    </div>
  );
}

/** A select in the same box. Selects with long option text get the rounded (22px) corners. */
export function SelectField({ label, help, error, ok, compact, className, id: givenId, children, ...select }:
  Common & SelectHTMLAttributes<HTMLSelectElement>) {
  const auto = useId();
  const id = givenId ?? auto;
  return (
    <div className={cls("fld--select", { label, compact, error, className })}>
      <label className="fld__label" htmlFor={id}>{label}</label>
      <div className="fld__box">
        <select {...select} id={id} aria-invalid={error ? true : undefined}
                aria-describedby={describedBy(id, help, error, ok, select["aria-describedby"])}>
          {children}
        </select>
      </div>
      <Messages id={id} help={help} error={error} ok={ok} />
    </div>
  );
}
