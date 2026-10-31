import { useEffect, useRef, type ReactNode } from 'react';

// The desk's in-page confirm. The native <dialog> gives the top layer, the focus trap and Escape, so it escapes Studio's
// transformed panels with no portal. Cancel takes the first focus: these confirm money moves and sign-outs.
export function ConfirmDialog({ title, children, confirm, danger, busy, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirm: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); return () => d?.close(); }, []);
  return (
    // Studio eats Escape at the document, so the dialog's own cancel event never fires inside it: catch the key here too.
    <dialog ref={ref} className="jd-dialog" aria-labelledby="jd-dialog-title" onCancel={(e) => { e.preventDefault(); if (!busy) onCancel(); }} onKeyDownCapture={(e) => { if (e.key === 'Escape' && !busy) onCancel(); }} onClick={(e) => { if (e.target === ref.current && !busy) onCancel(); }}>
      <div className="jd-dialog-body">
        <h2 id="jd-dialog-title">{title}</h2>
        {children}
      </div>
      <div className="jd-dialog-foot">
        <button type="button" className="jd-btn" autoFocus disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className={danger ? 'jd-btn jd-dialog-danger' : 'jd-btn jd-primary'} disabled={busy} onClick={onConfirm}>{confirm}</button>
      </div>
    </dialog>
  );
}
