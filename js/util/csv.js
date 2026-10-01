// Leading = + - @ tab/CR would be evaluated as formulas by spreadsheet apps.
const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value == null) return '';
  let s = String(value);
  if (FORMULA.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns, rows) {
  const lines = [columns.map((c) => csvCell(c.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(typeof c.value === 'function' ? c.value(row) : row[c.key])).join(','));
  }
  return lines.join('\r\n');
}
