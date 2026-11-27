// 1.176.1 walk 4: the row in use — the one whose control raised the toast
// that is about to show. A save path names its field (`noteRowInUse`), since
// the pressed offer ("Empty it") removes itself; any other save is read from
// the focus at the moment of the save (`noteControlInUse`). ToastStack keeps
// a toast off that row and the notice under it.

let fieldId: string | null = null;
let control: Element | null = null;

/** A checked field's save: its input's id. */
export function noteRowInUse(inputId: string): void {
  fieldId = inputId;
  control = null;
}

/** Any other save: the control that had the focus. */
export function noteControlInUse(el: Element | null): void {
  if (!el || el === document.body) return;
  control = el;
  fieldId = null;
}

/** A field that commits on blur names itself before it commits: by then the
 *  focus is on nothing, or on whatever was pressed next, never on the field.
 *  The save that follows in the same handler keeps this name. */
let named = false;
export function noteBlurredField(el: Element): void {
  control = el;
  fieldId = null;
  named = true;
  queueMicrotask(() => {
    named = false;
  });
}

/** True while a blur has just named its field (see `noteBlurredField`). */
export function rowJustNamed(): boolean {
  return named;
}

/** The control of the row in use, when it is still on the page. */
export function controlInUse(): Element | null {
  const byId = fieldId ? document.getElementById(fieldId) : null;
  if (byId) return byId;
  return control?.isConnected ? control : null;
}

/** The notice that belongs to a checked field (`CheckNotice`, marked by
 *  `useNoticeFocus`). */
export function noticeOf(control: Element): Element | null {
  return control.id ? document.querySelector(`[data-notice-for="${CSS.escape(control.id)}"]`) : null;
}
