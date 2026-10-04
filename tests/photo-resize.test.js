import test from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import exifParser from "exif-parser";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { parsePhoto } from "../dist/photo.js";
import { createMcpServer } from "../dist/server.js";

// APP1 Exif mínimo (TIFF little-endian) con Make, Orientation=6 y GPS 36°25'12"N 6°9'0"W.
function buildExifApp1() {
  const tiff = Buffer.alloc(160);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  const entry = (at, tag, type, count, value) => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    if (typeof value === "string") tiff.write(value, at + 8, "latin1");
    else if (type === 3) tiff.writeUInt16LE(value, at + 8);
    else tiff.writeUInt32LE(value, at + 8);
  };
  tiff.writeUInt16LE(3, 8);
  entry(10, 0x010f, 2, 8, 50); // Make -> "TestCam\0"
  entry(22, 0x0112, 3, 1, 6); // Orientation
  entry(34, 0x8825, 4, 1, 58); // GPS IFD
  tiff.writeUInt32LE(0, 46);
  tiff.write("TestCam\0", 50, "latin1");
  tiff.writeUInt16LE(4, 58);
  entry(60, 1, 2, 2, "N\0");
  entry(72, 2, 5, 3, 112);
  entry(84, 3, 2, 2, "W\0");
  entry(96, 4, 5, 3, 136);
  tiff.writeUInt32LE(0, 108);
  [36, 1, 25, 1, 12, 1, 6, 1, 9, 1, 0, 1].forEach((n, i) => tiff.writeUInt32LE(n, 112 + i * 4));
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function buildXmpApp1() {
  const payload = Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>fixture</x:xmpmeta>", "latin1");
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function synthJpeg(width, height, quality) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 7 + y * 3) & 0xff;
      data[i + 1] = ((x ^ y) * 5) & 0xff;
      data[i + 2] = ((x * y) >> 4) & 0xff;
      data[i + 3] = 0xff;
    }
  }
  return jpeg.encode({ width, height, data }, quality).data;
}

function withApp1(jpegBuf, segments) {
  return Buffer.concat([jpegBuf.subarray(0, 2), ...segments, jpegBuf.subarray(2)]);
}

const EXIF_APP1 = buildExifApp1();
const XMP_APP1 = buildXmpApp1();
const APP1 = Buffer.concat([EXIF_APP1, XMP_APP1]);
const LARGE = withApp1(synthJpeg(3000, 2000, 92), [EXIF_APP1, XMP_APP1]);

function exifTags(buf) {
  return exifParser.create(buf).parse().tags;
}

test("large JPEG is reduced to 2048 px longest side preserving original APP1 segments byte-for-byte", async () => {
  const info = await parsePhoto(LARGE.toString("base64"));
  const reduced = Buffer.from(info.base64, "base64");
  const decoded = jpeg.decode(reduced, { maxResolutionInMP: 100 });
  assert.equal(Math.max(decoded.width, decoded.height), 2048);
  assert.equal(decoded.width, 2048);
  assert.equal(decoded.height, 1365);
  assert.ok(reduced.length < LARGE.length, `reduced ${reduced.length} >= original ${LARGE.length}`);
  assert.deepEqual([reduced[0], reduced[1]], [0xff, 0xd8]);
  assert.ok(reduced.subarray(2, 2 + APP1.length).equals(APP1), "original APP1 segments must follow SOI unchanged");
  assert.equal(info.dataUri, `data:image/jpeg;base64,${info.base64}`);
  assert.equal(info.bytes, LARGE.length);
  assert.equal(info.uploadBytes, reduced.length);
  assert.equal(info.reduced, true);
  assert.equal(info.exifPreserved, true);
  assert.equal(info.width, 2048);
  assert.equal(info.height, 1365);

  const before = exifTags(LARGE);
  const after = exifTags(reduced);
  assert.equal(after.GPSLatitude, before.GPSLatitude);
  assert.equal(after.GPSLongitude, before.GPSLongitude);
  assert.equal(after.GPSLatitudeRef, "N");
  assert.equal(after.GPSLongitudeRef, "W");
  assert.equal(after.Orientation, 6);
  assert.equal(after.Make, "TestCam");
  assert.ok(info.gps);
  assert.ok(Math.abs(info.gps.lat - 36.42) < 1e-9);
  assert.ok(Math.abs(info.gps.lng + 6.15) < 1e-9);
  assert.equal(info.make, "TestCam");
});

test("JPEG already within 2048 px keeps the original bytes", async () => {
  const small = withApp1(synthJpeg(64, 48, 90), [EXIF_APP1]);
  const info = await parsePhoto(small.toString("base64"));
  assert.equal(info.base64, small.toString("base64"));
  assert.equal(info.reduced, false);
  assert.equal(info.exifPreserved, true);
  assert.equal(info.uploadBytes, small.length);
  assert.equal(info.width, 64);
  assert.equal(info.height, 48);
});

test("large JPEG whose reduction is not smaller keeps the original bytes", async () => {
  const tiny = synthJpeg(2100, 40, 1);
  const info = await parsePhoto(tiny.toString("base64"));
  assert.equal(info.base64, tiny.toString("base64"));
  assert.equal(info.reduced, false);
  assert.equal(info.exifPreserved, false);
  assert.equal(info.width, 2100);
});

test("PNG is never resized", async () => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(4000, 8);
  ihdr.writeUInt32BE(3000, 12);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
  const info = await parsePhoto(png.toString("base64"));
  assert.equal(info.base64, png.toString("base64"));
  assert.equal(info.reduced, false);
  assert.equal(info.uploadBytes, png.length);
  assert.equal(info.width, 4000);
  assert.equal(info.height, 3000);
});

test("undecodable oversized JPEG fails with a clear Spanish error", async () => {
  // SOF0 declarando 20000x20000 (400 MP) sin datos de imagen.
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x4e, 0x20, 0x4e, 0x20, 0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  const bogus = Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
  await assert.rejects(parsePhoto(bogus.toString("base64")), /No se pudo reducir la foto JPEG/);
});

class TestTransport {
  onmessage;
  onerror;
  onclose;
  peer;
  async start() {}
  async send(message) { queueMicrotask(() => this.peer.onmessage?.(message)); }
  async close() { this.onclose?.(); }
}

test("MCP preview reports the reduced photo and the confirmed submit uploads the reduced data URI", async () => {
  const previous = process.env.GECOR_ALLOW_SUBMISSION;
  process.env.GECOR_ALLOW_SUBMISSION = "true";
  const uploads = [];
  const fakeClient = {
    ayuntamientoID: 268,
    getPetitionerIdentity() { return { Nombre: "Ada", Email: "ada@example.test", Movil: "123", CiudadanoID: 9 }; },
    async getAyuntamiento() { return { AyuntamientoID: 268, Nombre: "Example" }; },
    async guardarFotoBase64(dataUri) { uploads.push(dataUri); return "fixture-photo"; },
    async nuevaIncidencia() { return { accepted: true }; },
  };
  const server = createMcpServer(fakeClient);
  const client = new Client({ name: "test-client", version: "1.0" });
  const left = new TestTransport();
  const right = new TestTransport();
  left.peer = right;
  right.peer = left;
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const previewResult = await client.callTool({ name: "create_aviso_from_photo", arguments: {
      description: "farola", tipoElementoID: 1, tipoIncID: 2, image_base64: LARGE.toString("base64"),
    } });
    assert.equal(previewResult.isError, undefined, previewResult.content[0].text);
    const preview = JSON.parse(previewResult.content[0].text);
    assert.equal(Object.hasOwn(preview, "peticionario"), false);
    assert.equal(preview.foto_adjunta, true);
    assert.ok(Math.abs(preview.ubicacion.lat - 36.42) < 1e-9, "GPS still read from the original EXIF");
    assert.equal(preview.foto.mime, "image/jpeg");
    assert.equal(preview.foto.original_bytes, LARGE.length);
    assert.ok(preview.foto.upload_bytes < LARGE.length);
    assert.equal(preview.foto.width, 2048);
    assert.equal(preview.foto.height, 1365);
    assert.equal(preview.foto.reducida, true);
    assert.equal(preview.foto.exif_conservado, true);
    assert.equal(uploads.length, 0);

    const accepted = await client.callTool({ name: "create_aviso_from_photo", arguments: {
      preview_token: preview.preview_token, confirm: true, human_confirmed: true,
    } });
    assert.equal(accepted.isError, undefined, accepted.content[0].text);
    assert.equal(uploads.length, 1);
    const prefix = "data:image/jpeg;base64,";
    assert.ok(uploads[0].startsWith(prefix));
    const uploaded = Buffer.from(uploads[0].slice(prefix.length), "base64");
    assert.equal(uploaded.length, preview.foto.upload_bytes);
    assert.ok(uploaded.subarray(2, 2 + APP1.length).equals(APP1));
    const decoded = jpeg.decode(uploaded);
    assert.equal(Math.max(decoded.width, decoded.height), 2048);
  } finally {
    await client.close();
    await server.close();
    if (previous === undefined) delete process.env.GECOR_ALLOW_SUBMISSION;
    else process.env.GECOR_ALLOW_SUBMISSION = previous;
  }
});
