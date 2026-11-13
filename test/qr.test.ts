import { test } from "node:test";
import assert from "node:assert/strict";

// public/admin/qr.js es un script de navegador: al cargarlo deja PeloteoQR en globalThis.
await import("../public/admin/qr.js");
const QR = (globalThis as any).PeloteoQR;
const I = QR._internal;

test("QR: Reed-Solomon da los códigos de corrección del ejemplo clásico (HELLO WORLD, 1-M)", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(I.rsRemainder(data, I.rsDivisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("QR: bits de formato (nivel M) y de versión según la norma", () => {
  const M = [
    "101010000010010",
    "101000100100101",
    "101111001111100",
    "101101101001011",
    "100010111111001",
    "100000011001110",
    "100111110010111",
    "100101010100000",
  ];
  M.forEach((bits, mask) => assert.equal(I.formatBits(mask).toString(2).padStart(15, "0"), bits, `máscara ${mask}`));
  assert.equal(I.versionBits(7).toString(2).padStart(18, "0"), "000111110010010100");
  assert.equal(I.versionBits(10).toString(2).padStart(18, "0"), "001010010011010011");
});

test("QR: capacidad y patrones de alineación por versión", () => {
  assert.deepEqual([1, 2, 5, 7, 10].map(I.numDataCodewords), [16, 28, 86, 124, 216]);
  assert.deepEqual(I.alignmentPositions(1), []);
  assert.deepEqual(I.alignmentPositions(2), [6, 18]);
  assert.deepEqual(I.alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(I.alignmentPositions(10), [6, 28, 50]);
});

test("QR: datos en modo byte con terminador y relleno", () => {
  // "hi": 0100 | 00000010 | 01101000 01101001 | 0000 | relleno EC 11 ...
  const cw = I.dataCodewords([0x68, 0x69], 1);
  assert.equal(cw.length, 16);
  assert.deepEqual(cw.slice(0, 5), [0x40, 0x26, 0x86, 0x90, 0xec]);
  assert.deepEqual(cw.slice(5, 7), [0x11, 0xec]);
});

test("QR: la dirección otpauth genera una matriz válida con buscadores y módulo oscuro", () => {
  const uri =
    "otpauth://totp/Peloteo:admin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Peloteo&algorithm=SHA1&digits=6&period=30";
  const m: boolean[][] = QR.encode(uri);
  const size = m.length;
  assert.equal(size, 7 * 4 + 17); // 106 bytes → versión 7 con nivel M
  const finder = (x: number, y: number) => {
    for (let dy = 0; dy < 7; dy++)
      for (let dx = 0; dx < 7; dx++) {
        const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(m[y + dy]![x + dx], d !== 2, `buscador en ${x},${y}`);
      }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);
  assert.equal(m[size - 8]![8], true);
  for (let i = 8; i < size - 8; i++) assert.equal(m[6]![i], i % 2 === 0);
  assert.match(QR.svg(uri, "QR"), /^<svg [^>]*viewBox="0 0 53 53"/);
});
