import { Fragment } from "react";

/** 1.173.0 (D1): text whose `backticked` parts are commands, drawn as code
 *  (the Railway row's `railway login`). */
export function BacktickCode({ text }: { text: string }) {
  const parts = text.split("`");
  // An unpaired backtick: the text as it is.
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}
