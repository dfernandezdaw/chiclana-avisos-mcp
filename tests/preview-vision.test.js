import test from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
  return Buffer.from(jpeg.encode({ width, height, data }, quality).data);
}

function withApp1(jpegBuf, segments) {
  return Buffer.concat([jpegBuf.subarray(0, 2), ...segments, jpegBuf.subarray(2)]);
}

function pngWithSize(width, height, padding = 0) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(padding)]);
}

/** Marcadores de cabecera hasta SOS */
function headerMarkers(buf) {
  const markers = [];
  let off = 2;
  while (off + 4 <= buf.length && buf[off] === 0xff) {
    const marker = buf[off + 1];
    if (marker === 0xda || marker === 0xd9) break;
    markers.push(marker);
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return markers;
}

const EXIF_APP1 = buildExifApp1();
const LARGE = withApp1(synthJpeg(3000, 2000, 92), [EXIF_APP1]);
const SMALL = withApp1(synthJpeg(320, 200, 90), [EXIF_APP1]);
const SMALL_PNG = pngWithSize(32, 16, 64);
const BIG_PNG = pngWithSize(4000, 3000, 1024 * 1024);
// SOF0 declarando 20000x20000 (400 MP) sin datos de imagen: no se puede decodificar.
const UNDECODABLE = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x4e, 0x20, 0x4e, 0x20, 0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
  Buffer.from([0xff, 0xd9]),
]);

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
  const previousAllow = process.env.GECOR_ALLOW_SUBMISSION;
  const previousFetch = globalThis.fetch;
  process.env.GECOR_ALLOW_SUBMISSION = "true";
  const calls = { fetch: [], client: [], uploads: [] };
  globalThis.fetch = async (...fetchArgs) => { calls.fetch.push(String(fetchArgs[0])); throw new Error("network disabled in tests"); };
  const fakeClient = {
    ayuntamientoID: 268,
    getPetitionerIdentity() { calls.client.push("getPetitionerIdentity"); return { Nombre: "Ada", Email: "ada@example.test", Movil: "123", CiudadanoID: 9 }; },
    async getAyuntamiento() { calls.client.push("getAyuntamiento"); return { AyuntamientoID: 268, Nombre: "Example" }; },
    async guardarFotoBase64(dataUri) { calls.client.push("guardarFotoBase64"); calls.uploads.push(dataUri); return "fixture-photo"; },
    async nuevaIncidencia() { calls.client.push("nuevaIncidencia"); return { accepted: true }; },
  };
  const server = createMcpServer(fakeClient);
  const client = new Client({ name: "test-client", version: "1.0" });
  const left = new TestTransport();
  const right = new TestTransport();
  left.peer = right;
  right.peer = left;
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const call = (args) => client.callTool({ name: "create_aviso_from_photo", arguments: args });
    await run({ call, calls });
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = previousFetch;
    if (previousAllow === undefined) delete process.env.GECOR_ALLOW_SUBMISSION;
    else process.env.GECOR_ALLOW_SUBMISSION = previousAllow;
  }
}

function textItem(result) {
  const items = result.content.filter((item) => item.type === "text");
  assert.equal(items.length, 1);
  return items[0].text;
}

function imageItem(result) {
  const items = result.content.filter((item) => item.type === "image");
  assert.equal(items.length, 1, "expected exactly one image content item");
  return items[0];
}

function assertJpegThumbnail(image) {
  assert.equal(image.mimeType, "image/jpeg");
  const thumb = Buffer.from(image.data, "base64");
  assert.deepEqual([thumb[0], thumb[1]], [0xff, 0xd8]);
  assert.equal(headerMarkers(thumb).includes(0xe1), false, "thumbnail must not carry APP1");
  assert.equal(thumb.includes(Buffer.from("Exif\0\0", "latin1")), false, "thumbnail must not carry Exif");
  assert.equal(thumb.includes(Buffer.from("TestCam", "latin1")), false);
  return { thumb, decoded: jpeg.decode(thumb) };
}

test("preview returns an EXIF-free ≤1024 px JPEG thumbnail as image content and still uploads the 2048 px copy with EXIF", async () => {
  await withServer(async ({ call, calls }) => {
    const result = await call({ description: "farola caída", tipoElementoID: 1, tipoIncID: 2, image_base64: LARGE.toString("base64") });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(result.content[0].type, "text");
    const image = imageItem(result);
    const { decoded } = assertJpegThumbnail(image);
    assert.ok(Math.max(decoded.width, decoded.height) <= 1024);
    // Orientation=6 se aplica a los píxeles porque la miniatura no lleva EXIF.
    assert.equal(decoded.width, 683);
    assert.equal(decoded.height, 1024);

    const text = textItem(result);
    assert.equal(text.includes(image.data.slice(0, 64)), false, "thumbnail base64 must not be inside the JSON");
    assert.ok(text.length < 4000, `JSON text unexpectedly large (${text.length})`);
    const body = JSON.parse(text);
    assert.equal(body.phase, "preview");
    assert.equal(body.foto.miniatura, true);
    assert.equal(body.foto.width, 2048);
    assert.match(body.instruccion, /miniatura|imagen/i);
    assert.match(body.instruccion, /categor/i);
    assert.match(body.instruccion, /descripci/i);

    const accepted = await call({ preview_token: body.preview_token, confirm: true, human_confirmed: true });
    assert.equal(accepted.isError, undefined, accepted.content[0].text);
    assert.equal(calls.uploads.length, 1);
    const prefix = "data:image/jpeg;base64,";
    assert.ok(calls.uploads[0].startsWith(prefix));
    const uploaded = Buffer.from(calls.uploads[0].slice(prefix.length), "base64");
    assert.ok(uploaded.subarray(2, 2 + EXIF_APP1.length).equals(EXIF_APP1), "upload keeps the original APP1");
    const full = jpeg.decode(uploaded);
    assert.equal(Math.max(full.width, full.height), 2048);
    assert.deepEqual(calls.fetch, []);
  });
});

test("small JPEG still gets a re-encoded thumbnail without EXIF", async () => {
  await withServer(async ({ call }) => {
    const result = await call({ description: "bache", tipoElementoID: 1, tipoIncID: 2, image_base64: SMALL.toString("base64") });
    assert.equal(result.isError, undefined, result.content[0].text);
    const { decoded } = assertJpegThumbnail(imageItem(result));
    assert.deepEqual([decoded.width, decoded.height], [200, 320]);
    assert.equal(JSON.parse(textItem(result)).foto.miniatura, true);
  });
});

test("small PNG is returned as-is as the thumbnail; large PNG gets none", async () => {
  await withServer(async ({ call }) => {
    const small = await call({ description: "pintada", tipoElementoID: 1, tipoIncID: 2, lat: 36, lng: -6, image_base64: SMALL_PNG.toString("base64") });
    assert.equal(small.isError, undefined, small.content[0].text);
    const image = imageItem(small);
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.data, SMALL_PNG.toString("base64"));
    assert.equal(JSON.parse(textItem(small)).foto.miniatura, true);

    const big = await call({ description: "pintada", tipoElementoID: 1, tipoIncID: 2, lat: 36, lng: -6, image_base64: BIG_PNG.toString("base64") });
    assert.equal(big.isError, undefined, big.content[0].text);
    assert.equal(big.content.some((item) => item.type === "image"), false);
    assert.equal(JSON.parse(textItem(big)).foto.miniatura, false);
  });
});

test("thumbnail failure does not fail the preview", async () => {
  await withServer(async ({ call, calls }) => {
    const result = await call({ description: "farola", tipoElementoID: 1, tipoIncID: 2, lat: 36, lng: -6, image_base64: UNDECODABLE.toString("base64") });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(result.content.some((item) => item.type === "image"), false);
    const body = JSON.parse(textItem(result));
    assert.equal(body.phase, "preview");
    assert.equal(body.foto.miniatura, false);
    assert.equal(typeof body.foto.aviso_miniatura, "string");
    assert.match(body.foto.aviso_miniatura, /miniatura/);
    assert.equal(typeof body.preview_token, "string");
    assert.ok(body.preview_token.length > 0);
    assert.deepEqual(calls.uploads, []);

    // Sin miniatura el envío sigue funcionando y sube la foto original intacta.
    const accepted = await call({ preview_token: body.preview_token, confirm: true, human_confirmed: true });
    assert.equal(accepted.isError, undefined, accepted.content[0].text);
    assert.deepEqual(calls.uploads, [`data:image/jpeg;base64,${UNDECODABLE.toString("base64")}`]);
    assert.ok(calls.client.includes("nuevaIncidencia"));
    assert.deepEqual(calls.fetch, []);
  });
});

for (const [label, description] of [["missing", undefined], ["blank", "   \n "]]) {
  test(`${label} description returns need_description with the thumbnail and no side effects`, async () => {
    await withServer(async ({ call, calls }) => {
      const args = { image_base64: LARGE.toString("base64") };
      if (description !== undefined) args.description = description;
      const result = await call(args);
      assert.equal(result.isError, undefined, result.content[0].text);
      assertJpegThumbnail(imageItem(result));
      const text = textItem(result);
      const body = JSON.parse(text);
      assert.equal(body.phase, "need_description");
      assert.equal(body.foto.miniatura, true);
      assert.equal(body.foto.mime, "image/jpeg");
      assert.equal(Object.hasOwn(body, "preview_token"), false);
      assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      assert.match(body.instruccion, /visible/i);
      assert.match(body.instruccion, /inventes/i);
      assert.match(body.instruccion, /description/);
      assert.deepEqual(calls, { fetch: [], client: [], uploads: [] });

      const confirm = await call({ preview_token: "any-token", confirm: true, human_confirmed: true });
      assert.equal(confirm.isError, true);
      assert.deepEqual(calls.uploads, []);
      assert.equal(calls.client.includes("nuevaIncidencia"), false);
    });
  });
}

test("invalid photo with missing description still errors", async () => {
  await withServer(async ({ call, calls }) => {
    const result = await call({ image_base64: Buffer.from("not an image at all").toString("base64") });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Formato no soportado/);
    assert.deepEqual(calls, { fetch: [], client: [], uploads: [] });
  });
});

test("overlong description is rejected with a clear message", async () => {
  await withServer(async ({ call }) => {
    const result = await call({ description: "a".repeat(1001), tipoElementoID: 1, tipoIncID: 2, lat: 36, lng: -6, image_base64: SMALL_PNG.toString("base64") });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /descripción/i);
    assert.match(result.content[0].text, /1000/);
  });
});
