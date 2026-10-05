function pad2(n) {
  return String(n).padStart(2, '0');
}

export function toLocalISO(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function dayKeyOf(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return toLocalISO(d);
}