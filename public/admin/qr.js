// Generador de códigos QR sin dependencias (ISO/IEC 18004), solo lo necesario
// para el QR del segundo factor: modo byte (UTF-8), corrección de errores M,
// versiones 1 a 10 (hasta 213 bytes). Devuelve un SVG.
//
// Basado en el algoritmo de referencia: datos → bloques con Reed-Solomon →
// ubicación en zigzag → la máscara con menor penalización.
(function (root) {
  'use strict';

  // Corrección M, por versión (índice 0 sin uso).
  const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const ECL_FORMAT_BITS = 0; // M
  const MAX_VERSION = 10;

  const getBit = (x, i) => ((x >>> i) & 1) !== 0;

  function numRawDataModules(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      r -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  const numDataCodewords = (ver) => Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

  // ---- Reed-Solomon sobre GF(2^8) con polinomio 0x11D ----
  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
  function rsDivisor(degree) {
    const r = new Array(degree).fill(0);
    r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < r.length; j++) {
        r[j] = gfMul(r[j], root);
        if (j + 1 < r.length) r[j] ^= r[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return r;
  }
  function rsRemainder(data, divisor) {
    const r = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ r.shift();
      r.push(0);
      divisor.forEach((coef, i) => { r[i] ^= gfMul(coef, factor); });
    }
    return r;
  }

  function utf8(text) {
    return Array.from(new TextEncoder().encode(text));
  }

  /** Codewords de datos (con modo, largo, terminador y relleno) para una versión. */
  function dataCodewords(bytes, ver) {
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(0b0100, 4); // modo byte
    push(bytes.length, ver <= 9 ? 8 : 16);
    bytes.forEach((b) => push(b, 8));
    const capacity = numDataCodewords(ver) * 8;
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    return out;
  }

  function withEccInterleaved(data, ver) {
    const numBlocks = NUM_BLOCKS[ver];
    const eccLen = ECC_PER_BLOCK[ver];
    const raw = Math.floor(numRawDataModules(ver) / 8);
    const numShort = numBlocks - (raw % numBlocks);
    const shortLen = Math.floor(raw / numBlocks);
    const div = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]); });
    }
    return out;
  }

  function alignmentPositions(ver) {
    if (ver === 1) return [];
    const size = ver * 4 + 17;
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const r = [6];
    for (let pos = size - 7; r.length < numAlign; pos -= step) r.splice(1, 0, pos);
    return r;
  }

  function formatBits(mask) {
    const data = (ECL_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function versionBits(ver) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (ver << 12) | rem;
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  /** Matriz de módulos (true = oscuro) para un texto. */
  function encode(text) {
    const bytes = utf8(text);
    let ver = 1;
    while (ver <= MAX_VERSION && bytes.length > numDataCodewords(ver) - (ver <= 9 ? 2 : 3)) ver++;
    if (ver > MAX_VERSION) throw new Error('Texto demasiado largo para el QR.');
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

    // Patrones de función.
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(([cx, cy]) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
        }
      }
    });
    const al = alignmentPositions(ver);
    al.forEach((ay, i) => al.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const drawFormat = (mask) => {
      const b = formatBits(mask);
      for (let i = 0; i <= 5; i++) setFn(8, i, getBit(b, i));
      setFn(8, 7, getBit(b, 6));
      setFn(8, 8, getBit(b, 7));
      setFn(7, 8, getBit(b, 8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(b, i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(b, i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(b, i));
      setFn(8, size - 8, true); // módulo oscuro fijo
    };
    drawFormat(0); // reserva las posiciones
    if (ver >= 7) {
      const b = versionBits(ver);
      for (let i = 0; i < 18; i++) {
        const bit = getBit(b, i);
        const a = size - 11 + (i % 3), c = Math.floor(i / 3);
        setFn(a, c, bit);
        setFn(c, a, bit);
      }
    }

    // Datos en zigzag, de abajo hacia arriba y de derecha a izquierda.
    const data = withEccInterleaved(dataCodewords(bytes, ver), ver);
    let k = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && k < data.length * 8) {
            modules[y][x] = getBit(data[k >>> 3], 7 - (k & 7));
            k++;
          }
        }
      }
    }

    // Elige la máscara con menor penalización.
    const applyMask = (m) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && MASKS[m](x, y)) modules[y][x] = !modules[y][x];
    };
    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      const score = penalty(modules);
      if (score < bestScore) { best = m; bestScore = score; }
      applyMask(m); // deshace (XOR)
    }
    applyMask(best);
    drawFormat(best);
    return modules;
  }

  function penalty(mod) {
    const size = mod.length;
    let score = 0;
    const lines = [];
    for (let y = 0; y < size; y++) lines.push(mod[y].map((d) => (d ? '1' : '0')).join(''));
    for (let x = 0; x < size; x++) lines.push(mod.map((row) => (row[x] ? '1' : '0')).join(''));
    for (const line of lines) {
      for (const run of line.match(/0{5,}|1{5,}/g) || []) score += run.length - 2;
      const padded = '0000' + line + '0000';
      score += 40 * ((padded.match(/(?=00001011101)/g) || []).length + (padded.match(/(?=10111010000)/g) || []).length);
    }
    let dark = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (mod[y][x]) dark++;
        if (x < size - 1 && y < size - 1) {
          const c = mod[y][x];
          if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
        }
      }
    }
    const total = size * size;
    score += Math.ceil(Math.abs(dark * 20 - total * 10) / total - 1) * 10;
    return score;
  }

  /** SVG con borde blanco de 4 módulos. Siempre negro sobre blanco, también en modo oscuro. */
  function svg(text, label) {
    const m = encode(text);
    const n = m.length + 8;
    let path = '';
    m.forEach((row, y) => row.forEach((d, x) => { if (d) path += 'M' + (x + 4) + ' ' + (y + 4) + 'h1v1h-1z'; }));
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" role="img" aria-label="' +
      String(label || 'Código QR').replace(/"/g, '&quot;') + '"><rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + path + '" fill="#000"/></svg>';
  }

  const api = { encode, svg, _internal: { rsDivisor, rsRemainder, formatBits, versionBits, dataCodewords, numDataCodewords, alignmentPositions } };
  root.PeloteoQR = api;
})(typeof window !== 'undefined' ? window : globalThis);
