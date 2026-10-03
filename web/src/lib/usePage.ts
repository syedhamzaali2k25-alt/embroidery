import { useLayoutEffect } from "react";

/** Each screen sets its own document title and body class (the ported CSS keys off body.<page>).
 *  A layout effect: the class is on <body> before the first paint, so the page is never drawn once
 *  without its styles and then moved (a layout shift). */
export function usePage(title: string, bodyClass: string) {
  useLayoutEffect(() => {
    document.title = title;
    document.body.className = bodyClass;
  }, [title, bodyClass]);
}
