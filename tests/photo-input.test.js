import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, realpath, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePhoto, loadPhotoBuffer } from "../dist/photo.js";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg fixture body")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png fixture body")]);

async function withEnv(vars, run) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function makeDirs() {
  const allowed = await realpath(await mkdtemp(path.join(tmpdir(), "photo-allowed-")));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "photo-outside-")));
  return { allowed, outside };
}

test("image_path outside allowed roots is rejected", async () => {
  const { allowed, outside } = await makeDirs();
  const file = path.join(outside, "foto.jpg");
  await writeFile(file, JPEG);
  await withEnv({ GECOR_PHOTO_DIRS: allowed, GECOR_MAX_PHOTO_BYTES: undefined }, async () => {
    await assert.rejects(parsePhoto(undefined, file), /GECOR_PHOTO_DIRS/);
  });
});

test("symlink inside allowed root pointing outside is rejected", async () => {
  const { allowed, outside } = await makeDirs();
  const target = path.join(outside, "secreto.jpg");
  await writeFile(target, JPEG);
  const link = path.join(allowed, "enlace.jpg");
  await symlink(target, link);
  await withEnv({ GECOR_PHOTO_DIRS: allowed, GECOR_MAX_PHOTO_BYTES: undefined }, async () => {
    await assert.rejects(parsePhoto(undefined, link), /GECOR_PHOTO_DIRS/);
  });
});

test("sibling directory sharing the allowed prefix is rejected", async () => {
  const { allowed } = await makeDirs();
  const sibling = `${allowed}-evil`;
  await (await import("node:fs/promises")).mkdir(sibling);
  const file = path.join(sibling, "foto.jpg");
  await writeFile(file, JPEG);
  await withEnv({ GECOR_PHOTO_DIRS: allowed, GECOR_MAX_PHOTO_BYTES: undefined }, async () => {
    await assert.rejects(parsePhoto(undefined, file), /GECOR_PHOTO_DIRS/);
  });
});

test("JPEG inside allowed root is accepted with image/jpeg mime", async () => {
  const { allowed } = await makeDirs();
  const file = path.join(allowed, "foto.jpg");
  await writeFile(file, JPEG);
  await withEnv({ GECOR_PHOTO_DIRS: allowed, GECOR_MAX_PHOTO_BYTES: undefined }, async () => {
    const info = await parsePhoto(undefined, file);
    assert.equal(info.mime, "image/jpeg");
    assert.equal(info.bytes, JPEG.length);
    assert.ok(info.dataUri.startsWith("data:image/jpeg;base64,"));
  });
});

test("PNG gets image/png mime", async () => {
  const { allowed } = await makeDirs();
  const file = path.join(allowed, "foto.png");
  await writeFile(file, PNG);
  await withEnv({ GECOR_PHOTO_DIRS: allowed, GECOR_MAX_PHOTO_BYTES: undefined }, async () => {
    const info = await parsePhoto(undefined, file);
    assert.equal(info.mime, "image/png");
    assert.ok(info.dataUri.startsWith("data:image/png;base64,"));
  });
  const fromBase64 = await parsePhoto(PNG.toString("base64"));
  assert.equal(fromBase64.mime, "image/png");
});

test("text file with .jpg extension is rejected", async () => {
  const { allowed } = await makeDirs();
  const file = path.join(allowed, "falso.jpg");
  await writeFile(file, "esto no es una imagen");
  await withEnv({ GECOR_PHOTO_DIRS: allowed, GECOR_MAX_PHOTO_BYTES: undefined }, async () => {
    await assert.rejects(parsePhoto(undefined, file), /Formato no soportado: usa JPEG o PNG/);
  });
  await assert.rejects(parsePhoto(Buffer.from("texto").toString("base64")), /Formato no soportado: usa JPEG o PNG/);
});

test("GIF, WebP and HEIC are rejected", async () => {
  const samples = [
    Buffer.from("GIF89a....."),
    Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]),
    Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(8)]),
  ];
  for (const sample of samples) {
    await assert.rejects(parsePhoto(sample.toString("base64")), /Formato no soportado: usa JPEG o PNG/);
  }
});

test("non-regular files are rejected", async () => {
  const { allowed } = await makeDirs();
  await withEnv({ GECOR_PHOTO_DIRS: allowed, GECOR_MAX_PHOTO_BYTES: undefined }, async () => {
    await assert.rejects(loadPhotoBuffer(undefined, allowed), /fichero regular/);
  });
});

test("oversize file is rejected before reading", async () => {
  const { allowed } = await makeDirs();
  const file = path.join(allowed, "grande.jpg");
  await writeFile(file, Buffer.concat([JPEG, Buffer.alloc(200)]));
  await withEnv({ GECOR_PHOTO_DIRS: allowed, GECOR_MAX_PHOTO_BYTES: "64" }, async () => {
    await assert.rejects(parsePhoto(undefined, file), /demasiado grande/);
  });
});

test("oversize and invalid base64 are rejected", async () => {
  await withEnv({ GECOR_MAX_PHOTO_BYTES: "64" }, async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(200)]).toString("base64");
    await assert.rejects(parsePhoto(big), /demasiado grande/);
  });
  await withEnv({ GECOR_MAX_PHOTO_BYTES: undefined }, async () => {
    await assert.rejects(parsePhoto("/9j/4A!!invalid$$"), /base64/);
    await assert.rejects(parsePhoto("data:text/html;base64,PGh0bWw+"), /base64/);
    const wrapped = `data:image/jpeg;base64,${JPEG.toString("base64").replace(/(.{8})/g, "$1\n")}`;
    const info = await parsePhoto(wrapped);
    assert.equal(info.mime, "image/jpeg");
    assert.equal(info.bytes, JPEG.length);
  });
});

test("FIFO inside allowed root is rejected without blocking", { skip: process.platform === "win32" }, async () => {
  const { allowed } = await makeDirs();
  const fifo = path.join(allowed, "tuberia.jpg");
  execFileSync("mkfifo", [fifo]);
  await withEnv({ GECOR_PHOTO_DIRS: allowed, GECOR_MAX_PHOTO_BYTES: undefined }, async () => {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), 2000); });
    const outcome = await Promise.race([
      loadPhotoBuffer(undefined, fifo).then(() => "accepted", (err) => err),
      timeout,
    ]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      // Desbloquea el open() colgado para que el proceso de test pueda terminar.
      const writer = await open(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
      await writer.close();
    }
    assert.ok(outcome instanceof Error, `expected rejection, got ${String(outcome)}`);
    assert.match(outcome.message, /fichero regular/);
  });
});
