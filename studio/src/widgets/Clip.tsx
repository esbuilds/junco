import { useState } from 'react';
import { oneLine } from '../ui';

// A long entry as one line. A click opens the full text in place and closes it again.
export function Clip({ text, max }: { text: string; max?: number }) {
  const [open, setOpen] = useState(false), short = oneLine(text, max);
  if (short === text) return <>{text}</>;
  return <button type="button" className="jd-clip" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? text : short}</button>;
}
