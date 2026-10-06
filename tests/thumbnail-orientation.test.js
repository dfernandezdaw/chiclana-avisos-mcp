import test from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { orientRgba } from "../dist/image.js";
import { parsePhoto } from "../dist/photo.js";

// Origen 3x2 con un identificador distinto por píxel en el canal R:
//   a b c
//   d e f
const [a, b, c, d, e, f] = [10, 20, 30, 40, 50, 60];
const SOURCE = [[a, b, c], [d, e, f]];

function rgbaFromRows(rows) {
  const width = rows[0].length;
  const data = Buffer.alloc(width * rows.length * 4);
  rows.flat().forEach((id, i) => {
    data[i * 4] = id;
    data[i * 4 + 1] = id + 1;
    data[i * 4 + 2] = id + 2;
    data[i * 4 + 3] = 255;
  });
  return data;
}

function rowsFromRgba(data, width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      assert.deepEqual([data[i + 1], data[i + 2], data[i + 3]], [data[i] + 1, data[i] + 2, 255], "channels move together");
      row.push(data[i]);
    }
    rows.push(row);
  }
  return rows;
}

// Imagen vertical resultante según la especificación EXIF de Orientation.
const EXPECTED = {
  1: [[a, b, c], [d, e, f]], // identidad
  2: [[c, b, a], [f, e, d]], // espejo horizontal
  3: [[f, e, d], [c, b, a]], // giro 180°
  4: [[d, e, f], [a, b, c]], // espejo vertical
  5: [[a, d], [b, e], [c, f]], // transposición
  6: [[d, a], [e, b], [f, c]], // giro 90° horario
  7: [[f, c], [e, b], [d, a]], // transversa
  8: [[c, f], [b, e], [a, d]], // giro 90° antihorario
};

for (const [orientation, expected] of Object.entries(EXPECTED)) {
  test(`orientRgba maps EXIF orientation ${orientation} to the upright image`, () => {
    const out = orientRgba(rgbaFromRows(SOURCE), 3, 2, Number(orientation));
    const swapped = Number(orientation) >= 5;
    assert.deepEqual([out.width, out.height], swapped ? [2, 3] : [3, 2]);
    assert.equal(out.data.length, 3 * 2 * 4);
    assert.deepEqual(rowsFromRgba(out.data, out.width, out.height), expected);
  });
}

test("orientRgba leaves pixels untouched for missing or out-of-range orientations", () => {
  for (const orientation of [0, 9, 1.5, NaN]) {
    const src = rgbaFromRows(SOURCE);
    const out = orientRgba(src, 3, 2, orientation);
    assert.deepEqual([out.width, out.height], [3, 2]);
    assert.deepEqual(rowsFromRgba(out.data, 3, 2), SOURCE);
  }
});

// APP1 Exif mínimo (TIFF little-endian) con solo Orientation.
function orientationApp1(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];

/** JPEG 64x32 con cuadrantes sólidos: rojo|verde arriba, azul|blanco abajo */
function quadrantJpeg() {
  const width = 64;
  const height = 32;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = y < height / 2 ? (x < width / 2 ? RED : GREEN) : (x < width / 2 ? BLUE : WHITE);
      data.set([...color, 255], (y * width + x) * 4);
    }
  }
  return Buffer.from(jpeg.encode({ width, height, data }, 95).data);
}

function assertColorNear(decoded, x, y, expected, label) {
  const i = (y * decoded.width + x) * 4;
  const actual = [decoded.data[i], decoded.data[i + 1], decoded.data[i + 2]];
  assert.ok(actual.every((v, k) => Math.abs(v - expected[k]) <= 40), `${label}: expected ~${expected}, got ${actual}`);
}

test("parsePhoto applies EXIF Orientation=6 to the thumbnail pixels end to end", async () => {
  const src = quadrantJpeg();
  const withExif = Buffer.concat([src.subarray(0, 2), orientationApp1(6), src.subarray(2)]);
  const info = await parsePhoto(withExif.toString("base64"));
  assert.ok(info.thumbnail, info.thumbnailWarning);
  assert.equal(info.thumbnail.mime, "image/jpeg");
  assert.deepEqual([info.thumbnail.width, info.thumbnail.height], [32, 64]);
  const decoded = jpeg.decode(Buffer.from(info.thumbnail.base64, "base64"));
  assert.deepEqual([decoded.width, decoded.height], [32, 64]);
  // Giro 90° horario: la columna izquierda almacenada pasa a ser la fila superior.
  assertColorNear(decoded, 4, 4, BLUE, "upright top-left");
  assertColorNear(decoded, 27, 4, RED, "upright top-right");
  assertColorNear(decoded, 4, 59, WHITE, "upright bottom-left");
  assertColorNear(decoded, 27, 59, GREEN, "upright bottom-right");
  // La subida conserva los píxeles almacenados sin rotar.
  assert.deepEqual([info.width, info.height], [64, 32]);
});
