export function finite(value, name, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new TypeError(`${name}: numero fuori intervallo`);
  return value;
}
export function probability(value, name = 'probabilità', open = false) {
  finite(value, name, 0, 1);
  if (open && (value === 0 || value === 1)) throw new RangeError(`${name}: richiesto 0 < p < 1`);
  return value;
}
export function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError('Timestamp ISO UTC richiesto');
  return Date.parse(value);
}
export function solve(matrix, vector) {
  const n = vector.length;
  if (!n || matrix.length !== n || matrix.some(r => r.length !== n)) throw new Error('Sistema non quadrato');
  const a = matrix.map((r, i) => [...r, vector[i]]);
  a.flat().forEach(x => finite(x, 'coefficiente'));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-13) throw new Error('Sistema singolare o mal condizionato');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const scale = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= scale;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map(r => r[n]);
}
export function normalCDF(z) {
  finite(z, 'z');
  if (z === 0) return 0.5;
  const x = Math.abs(z), t = 1 / (1 + 0.2316419 * x);
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - tail : tail;
}
