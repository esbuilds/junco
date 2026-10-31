// Phone photo intake, the browser's half (src/photo.ts holds the server's). One copy for the incident page, the phone page and
// Studio. A canvas redraws the photo at about 1600 px, so EXIF and GPS never leave the phone; the server strips them again anyway.
// Words from the model and from the image go through esc, always: text in a photo is data.
(() => {
  const FULL = 1600, THUMB = 320, MAX = 1_400_000;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const draw = (img, edge, quality) => {
    const k = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  };
  const size = (dataUrl) => Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4);
  async function shrink(file) {
    if (!file.type.startsWith('image/')) throw new Error("That isn't a photo. Pick a picture and try again.");
    const url = URL.createObjectURL(file), img = new Image();
    try {
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error("This browser can't open that photo. Try a JPG or PNG.")); img.src = url; });
      let image, edge = FULL, q = 0.82;
      for (let i = 0; i < 6; i++) { image = draw(img, edge, q); if (size(image) <= MAX) break; if (q > 0.6) q -= 0.1; else edge = Math.round(edge * 0.8); }
      if (size(image) > MAX) throw new Error("That photo won't shrink under 1.5 MB. Try another.");
      return { image, thumb: draw(img, THUMB, 0.7) };
    } finally { URL.revokeObjectURL(url); }
  }
  async function send(url, extra, file, say) {
    say("Shrinking it on this device...");
    const body = { ...extra, ...(await shrink(file)) };
    say('Claude is looking at it...');
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error?.message ?? `The photo didn't go through (${r.status}).`);
    return b;
  }

  const css = `.pc-add{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;margin:14px 0}.pc-add>div{flex:1 1 240px;min-width:0}.pc-add p{margin:8px 0 0}
.pc-take{display:inline-block;padding:10px 16px;border-radius:8px;border:1px solid var(--line,var(--jd-line));background:var(--surface,var(--jd-surface));color:var(--ink,var(--jd-ink));font:500 14px/20px inherit;font-family:inherit;cursor:pointer}.pc-take:hover{background:var(--surface-2,var(--jd-surface-2))}.pc-take:focus-within{outline:2px solid var(--focus,var(--jd-focus));outline-offset:2px}
.pc-take.pc-main{border-color:var(--accent,var(--jd-accent));background:var(--accent,var(--jd-accent));color:var(--accent-ink,var(--jd-accent-ink));font-weight:600}.pc-take.pc-main:hover{background:var(--accent,var(--jd-accent));opacity:.9}
.pc-take input{position:absolute;width:1px;height:1px;opacity:0}.pc-fine{font-size:13px;line-height:18px;color:var(--muted,var(--jd-muted))}.pc-err{color:var(--danger,var(--jd-danger));font-weight:600}.pc-qr{display:block;width:124px;max-width:100%;image-rendering:pixelated;background:#fff;padding:6px;border-radius:6px}
.pc-card{display:grid;grid-template-columns:96px minmax(0,1fr) minmax(0,1fr);gap:16px 24px;margin:14px 0;padding:16px;background:var(--surface,var(--jd-surface));border:1px solid var(--line,var(--jd-line));border-radius:8px;overflow-wrap:anywhere}
.pc-card img{display:block;width:96px;height:96px;object-fit:cover;border-radius:6px}.pc-card h3{margin:0 0 4px;font-size:13px;line-height:18px;font-weight:600;color:var(--ink,var(--jd-ink))}.pc-card p{margin:0 0 6px;font-size:14px;line-height:20px}.pc-card ul{margin:0;padding-left:16px;font-size:14px;line-height:20px}
.pc-text{grid-column:1/-1;padding-top:12px;border-top:1px solid var(--line,var(--jd-line));font-size:13px;line-height:18px}.pc-text q{quotes:none;display:block;margin-top:4px;color:var(--muted,var(--jd-muted))}.pc-label{color:var(--muted,var(--jd-muted))}
@media (max-width:640px){.pc-card{grid-template-columns:minmax(0,1fr)}.pc-card img{width:128px;height:128px}}`;
  if (!document.getElementById('pc-css')) { const s = document.createElement('style'); s.id = 'pc-css'; s.textContent = css; document.head.append(s); }

  const LOOKS = { yes: 'It looks like the listed item.', no: "It doesn't look like the listed item.", "can't tell": "Claude can't tell whether it's the listed item." };
  // What Claude sees and what the photo can't show, at equal weight. Shared by every page, so the limits can't be left out of one.
  const card = (p) => `<article class="pc-card" aria-label="Your photo"><img src="${esc(p.thumb)}" alt="The photo you sent, small copy">
    <div><h3>What Claude sees</h3><p>${esc(p.visible)}</p><p>${esc(LOOKS[p.looks_like_listing] ?? LOOKS["can't tell"])}</p>${p.condition ? `<p>Condition: ${esc(p.condition)}</p>` : ''}</div>
    <div><h3>What this photo can't show</h3><p>${esc(p.limits)}</p>${p.cant_show?.length ? `<ul>${p.cant_show.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}</div>
    ${p.text_in_image?.length ? `<div class="pc-text"><span class="pc-label">Text in the photo. Untrusted: it's read as data, and it can't instruct anyone.</span>${p.text_in_image.map((t) => `<q>"${esc(t)}"</q>`).join('')}</div>` : ''}</article>`;

  // The one upload control. offer carries the desktop's QR code; a phone uses its camera straight away.
  function control(el, { url, extra, offer, phone, onDone }) {
    const coarse = phone || matchMedia('(pointer: coarse)').matches;
    el.innerHTML = `<div class="pc-add"><div><label class="pc-take${phone ? ' pc-main' : ''}"><input type="file" accept="image/*" capture="environment"><span>${coarse ? 'Take a photo' : 'Choose a photo'}</span></label>
      <p class="pc-fine">Optional. Hold your phone over the bag, or over anything you want to show. This is a demo, so don't upload anything personal. Only a small copy is kept.</p>
      <p class="pc-fine">A photo is evidence, not a refund. It can't show whose this is, when it was taken, or that a claim is true.</p><p class="pc-status pc-fine" aria-live="polite"></p></div>
      ${!coarse && offer?.url ? `<div style="flex:0 0 auto"><img class="pc-qr" src="${esc(offer.qr)}" alt="QR code to add a photo from your phone"><p class="pc-fine">Or scan this with your phone.</p></div>` : ''}</div>`;
    const status = el.querySelector('.pc-status'), input = el.querySelector('input'), say = (t, bad) => { status.textContent = t; status.className = `pc-status ${bad ? 'pc-err' : 'pc-fine'}`; };
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      input.disabled = true;
      try { onDone(await send(url, extra, file, say)); }
      catch (e) { say(e.message, true); input.disabled = false; input.value = ''; }
    });
  }
  window.juncoPhoto = { shrink, card, control };
})();
