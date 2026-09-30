import { useEffect } from "react";

/** Each screen sets its own document title and body class (the ported CSS keys off body.<page>). */
export function usePage(title: string, bodyClass: string) {
  useEffect(() => {
    document.title = title;
    document.body.className = bodyClass;
  }, [title, bodyClass]);
}
