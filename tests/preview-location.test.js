import test from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../dist/server.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture image")]);

function synthJpeg(width, height) {
  const data = Buffer.alloc(width * height * 4, 0x80);
  return Buffer.from(jpeg.encode({ width, height, data }, 80).data);
}

// APP1 Exif mínimo con solo GPSLatitude (grados indicados, N) y GPSLongitude 6°W.
function buildGpsApp1(latDegrees) {
  const tiff = Buffer.alloc(128);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  const entry = (at, tag, type, count, value) => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    if (typeof value === "string") tiff.write(value, at + 8, "latin1");
    else tiff.writeUInt32LE(value, at + 8);
  };
  tiff.writeUInt16LE(1, 8);
  entry(10, 0x8825, 4, 1, 26); // GPS IFD
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(4, 26);
  entry(28, 1, 2, 2, "N\0");
  entry(40, 2, 5, 3, 80);
  entry(52, 3, 2, 2, "W\0");
  entry(64, 4, 5, 3, 104);
  tiff.writeUInt32LE(0, 76);
  [latDegrees, 1, 0, 1, 0, 1].forEach((n, i) => tiff.writeUInt32LE(n, 80 + i * 4));
  [6, 1, 0, 1, 0, 1].forEach((n, i) => tiff.writeUInt32LE(n, 104 + i * 4));
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

const JPEG_NO_GPS = synthJpeg(16, 16);
const JPEG_BAD_GPS = Buffer.concat([JPEG_NO_GPS.subarray(0, 2), buildGpsApp1(95), JPEG_NO_GPS.subarray(2)]);

class TestTransport {
  onmessage;
  onerror;
  onclose;
  peer;
  async start() {}
  async send(message) { queueMicrotask(() => this.peer.onmessage?.(message)); }
  async close() { this.onclose?.(); }
}

async function withServer(run) {
  const calls = { upload: 0, submit: 0, fetch: 0 };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls.fetch++; throw new Error("network disabled in tests"); };
  const fakeClient = {
    ayuntamientoID: 268,
    getPetitionerIdentity() { return { Nombre: "Ada", Email: "ada@example.test", Movil: "123", CiudadanoID: 9 }; },
    async getAyuntamiento() { return { AyuntamientoID: 268, Nombre: "Example" }; },
    async guardarFotoBase64() { calls.upload++; return "fixture-photo"; },
    async nuevaIncidencia() { calls.submit++; return { accepted: true }; },
  };
  const server = createMcpServer(fakeClient);
  const client = new Client({ name: "test-client", version: "1.0" });
  const left = new TestTransport();
  const right = new TestTransport();
  left.peer = right;
  right.peer = left;
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const preview = (extra) => client.callTool({ name: "create_aviso_from_photo", arguments: {
      description: "farola apagada", tipoElementoID: 1, tipoIncID: 2, ...extra,
    } });
    await run({ preview, calls });
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = previousFetch;
  }
}

function assertNoSideEffects(calls) {
  assert.deepEqual(calls, { upload: 0, submit: 0, fetch: 0 });
}

test("JPEG without GPS and no lat/lng explains how to obtain a location", async () => {
  await withServer(async ({ preview, calls }) => {
    const result = await preview({ image_base64: JPEG_NO_GPS.toString("base64") });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /ubicación/i);
    assert.match(text, /pin/i);
    assert.match(text, /coordenadas/i);
    assert.match(text, /Telegram|WhatsApp/);
    assert.match(text, /archivo|documento/i);
    assert.match(text, /inventes/i);
    assert.match(text, /resolve_location/);
    assert.doesNotMatch(text, /Latitud inválida/);
    assert.doesNotMatch(text, /preview_token/);
    assertNoSideEffects(calls);
  });
});

test("PNG without lat/lng says PNG carries no EXIF location", async () => {
  await withServer(async ({ preview, calls }) => {
    const result = await preview({ image_base64: PNG.toString("base64") });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /PNG/);
    assert.match(text, /sin EXIF|no contiene EXIF|EXIF/);
    assert.match(text, /ubicación/i);
    assert.doesNotMatch(text, /Latitud inválida/);
    assertNoSideEffects(calls);
  });
});

test("JPEG with out-of-range EXIF GPS reuses the photo warning", async () => {
  await withServer(async ({ preview, calls }) => {
    const result = await preview({ image_base64: JPEG_BAD_GPS.toString("base64") });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /ubicación/i);
    assert.match(text, /fuera de rango/);
    assert.doesNotMatch(text, /Latitud inválida/);
    assertNoSideEffects(calls);
  });
});

test("explicit invalid coordinates keep their own validation message", async () => {
  await withServer(async ({ preview, calls }) => {
    const badLat = await preview({ image_base64: JPEG_NO_GPS.toString("base64"), lat: 200, lng: -6 });
    assert.equal(badLat.isError, true);
    assert.match(badLat.content[0].text, /Latitud inválida/);
    const badLng = await preview({ image_base64: JPEG_NO_GPS.toString("base64"), lat: 36, lng: -181 });
    assert.equal(badLng.isError, true);
    assert.match(badLng.content[0].text, /Longitud inválida/);
    assertNoSideEffects(calls);
  });
});

test("only one of lat/lng gives a clear message", async () => {
  await withServer(async ({ preview, calls }) => {
    const onlyLat = await preview({ image_base64: JPEG_NO_GPS.toString("base64"), lat: 36.42 });
    assert.equal(onlyLat.isError, true);
    assert.match(onlyLat.content[0].text, /falta la longitud/i);
    assert.match(onlyLat.content[0].text, /ambas/i);
    const onlyLng = await preview({ image_base64: JPEG_NO_GPS.toString("base64"), lng: -6.15 });
    assert.equal(onlyLng.isError, true);
    assert.match(onlyLng.content[0].text, /falta la latitud/i);
    assertNoSideEffects(calls);
  });
});

test("JPEG without GPS plus explicit valid lat/lng previews successfully", async () => {
  await withServer(async ({ preview, calls }) => {
    const result = await preview({ image_base64: JPEG_NO_GPS.toString("base64"), lat: 36.42, lng: -6.15 });
    assert.equal(result.isError, undefined, result.content[0].text);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.phase, "preview");
    assert.deepEqual([body.ubicacion.lat, body.ubicacion.lng], [36.42, -6.15]);
    assertNoSideEffects(calls);
  });
});
