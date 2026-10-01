const PAGE_SIZES = { letter: [612, 792], a4: [595.28, 841.89] };

const enc = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

const num = (n) => (Math.round(n * 100) / 100).toString();

// Single-page PDF embedding a baseline JPEG (DCTDecode), fitted and centred on the page.
export function buildJpegPdf(jpeg, imgWidth, imgHeight, { page = 'letter', margin = 24 } = {}) {
  if (!(jpeg instanceof Uint8Array) || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error('buildJpegPdf expects JPEG bytes');
  }
  if (!(imgWidth > 0 && imgHeight > 0)) throw new Error('Invalid image size');
  const [shortSide, longSide] = PAGE_SIZES[page] ?? PAGE_SIZES.letter;
  const landscape = imgWidth >= imgHeight;
  const pw = landscape ? longSide : shortSide;
  const ph = landscape ? shortSide : longSide;
  const scale = Math.min((pw - 2 * margin) / imgWidth, (ph - 2 * margin) / imgHeight);
  const dw = imgWidth * scale;
  const dh = imgHeight * scale;
  const x = (pw - dw) / 2;
  const y = (ph - dh) / 2;

  const content = `q ${num(dw)} 0 0 ${num(dh)} ${num(x)} ${num(y)} cm /Im0 Do Q`;
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (bytes) => {
    parts.push(bytes);
    length += bytes.length;
  };
  const obj = (n, body) => {
    offsets[n] = length;
    push(enc(`${n} 0 obj\n${body}\nendobj\n`));
  };

  push(enc('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'));
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pw)} ${num(ph)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = length;
  push(enc(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${Math.round(imgWidth)} /Height ${Math.round(imgHeight)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`));
  push(jpeg);
  push(enc('\nendstream\nendobj\n'));
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

  const xrefAt = length;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(enc(`${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
