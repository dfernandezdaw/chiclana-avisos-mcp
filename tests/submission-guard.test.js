import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../dist/server.js";

const FIXTURE_IMAGE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture image")]);

class TestTransport {
  onmessage;
  onerror;
  onclose;
  peer;
  async start() {}
  async send(message) { queueMicrotask(() => this.peer.onmessage?.(message)); }
  async close() { this.onclose?.(); }
}

function linkedTransports() {
  const left = new TestTransport();
  const right = new TestTransport();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

test("photo-to-notice facade previews without writes and confirms only its bound payload", async () => {
  const calls = { upload: [], submit: [] };
  const fakeClient = {
    ayuntamientoID: 268,
    getPetitionerIdentity() { return { Nombre: "Ada", Email: "ada@example.test", Movil: "123", CiudadanoID: 9 }; },
    async getAyuntamiento() { return { AyuntamientoID: 268, Nombre: "Example" }; },
    async guardarFotoBase64(dataUri) { calls.upload.push(dataUri); return "fixture-photo"; },
    async nuevaIncidencia(payload) { calls.submit.push(payload); return { accepted: true }; },
  };
  const server = createMcpServer(fakeClient);
  const client = new Client({ name: "test-client", version: "1.0" });
  const [clientTransport, serverTransport] = linkedTransports();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const advertised = await client.listTools();
    const toolNames = advertised.tools.map((tool) => tool.name);
    assert.equal(toolNames.includes("parse_photo_gps"), false);
    assert.equal(toolNames.includes("create_aviso_from_photo"), true);
    assert.equal(toolNames.includes("create_aviso_preview"), false);
    assert.equal(toolNames.includes("create_aviso"), false);
    const noPhoto = await client.callTool({ name: "create_aviso_from_photo", arguments: {
      description: "missing photo", tipoElementoID: 1, tipoIncID: 2, lat: 36, lng: -6,
    } });
    assert.equal(noPhoto.isError, true);
    for (const emptyPhoto of [{ image_path: "  " }, { image_base64: "\n" }]) {
      const rejected = await client.callTool({ name: "create_aviso_from_photo", arguments: {
        description: "empty photo", tipoElementoID: 1, tipoIncID: 2, lat: 36, lng: -6, ...emptyPhoto,
      } });
      assert.equal(rejected.isError, true);
      assert.deepEqual(calls, { upload: [], submit: [] });
    }
    assert.deepEqual(calls, { upload: [], submit: [] });
    const image = FIXTURE_IMAGE.toString("base64");
    const previewResult = await client.callTool({ name: "create_aviso_from_photo", arguments: {
      description: "bound description", tipoElementoID: 1, tipoIncID: 2,
      lat: 36, lng: -6, image_base64: image,
    } });
    assert.equal(previewResult.isError, undefined);
    const preview = JSON.parse(previewResult.content[0].text);
    assert.equal(preview.phase, "preview");
    assert.ok(preview.preview_token);
    assert.equal(Object.hasOwn(preview, "peticionario"), false);
    for (const key of ["petitioner", "identity", "email", "phone", "raw_payload", "payload"]) {
      assert.equal(Object.hasOwn(preview, key), false, `preview must omit ${key}`);
    }
    assert.deepEqual(calls, { upload: [], submit: [] });

    const bad = await client.callTool({ name: "create_aviso_from_photo", arguments: {
      preview_token: preview.preview_token, confirm: true, human_confirmed: false,
    } });
    assert.equal(bad.isError, true);
    const changed = await client.callTool({ name: "create_aviso_from_photo", arguments: {
      preview_token: preview.preview_token, confirm: true, human_confirmed: true, description: "changed",
    } });
    assert.equal(changed.isError, true);

    assert.deepEqual(calls, { upload: [], submit: [] });

    const accepted = await client.callTool({ name: "create_aviso_from_photo", arguments: {
      preview_token: preview.preview_token, confirm: true, human_confirmed: true,
    } });
    assert.equal(accepted.isError, undefined);
    const result = JSON.parse(accepted.content[0].text);
    assert.equal(result.phase, "submitted");
    assert.equal(calls.upload.length, 1);
    assert.equal(calls.submit.length, 1);
    assert.equal(calls.submit[0].desAveria, "bound description");
    assert.equal(calls.submit[0].ciudadanoID, 9);
    assert.equal(calls.submit[0].nombrePeticionario, "Ada");
    assert.equal(calls.submit[0].email, "ada@example.test");
    assert.equal(calls.submit[0].movil, "123");
    assert.deepEqual(calls.submit[0].fotos, [{ rutaFoto: "fixture-photo" }]);
    const replay = await client.callTool({ name: "create_aviso_from_photo", arguments: {
      preview_token: preview.preview_token, confirm: true, human_confirmed: true,
    } });
    assert.equal(replay.isError, true);
    assert.equal(calls.submit.length, 1);
  } finally {
    await client.close(); await server.close();
  }
});

test("confirmed submission needs no env opt-in and ignores the removed GECOR_ALLOW_SUBMISSION", async () => {
  // GECOR_ALLOW_SUBMISSION se eliminó: ni ausente ni "false" bloquean un envío confirmado.
  const previous = process.env.GECOR_ALLOW_SUBMISSION;
  const calls = { upload: [], submit: [] };
  const fakeClient = {
    ayuntamientoID: 268,
    getPetitionerIdentity() { return { Nombre: "Ada", Email: "ada@example.test", Movil: "123", CiudadanoID: 9 }; },
    async getAyuntamiento() { return { AyuntamientoID: 268, Nombre: "Example" }; },
    async guardarFotoBase64(dataUri) { calls.upload.push(dataUri); return "fixture-photo"; },
    async nuevaIncidencia(payload) { calls.submit.push(payload); return { accepted: true }; },
  };
  const server = createMcpServer(fakeClient);
  const client = new Client({ name: "test-client", version: "1.0" });
  const [clientTransport, serverTransport] = linkedTransports();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const expectedPhotoDataUri = `data:image/png;base64,${FIXTURE_IMAGE.toString("base64")}`;
    for (const [index, envValue] of [undefined, "false"].entries()) {
      if (envValue === undefined) delete process.env.GECOR_ALLOW_SUBMISSION;
      else process.env.GECOR_ALLOW_SUBMISSION = envValue;
      const previewResult = await client.callTool({
        name: "create_aviso_from_photo",
        arguments: {
          description: `fixture description ${index}`, tipoElementoID: 1, tipoIncID: 2,
          lat: 36, lng: -6, image_base64: FIXTURE_IMAGE.toString("base64"),
        },
      });
      const preview = JSON.parse(previewResult.content[0].text);
      assert.equal(preview.phase, "preview");
      assert.doesNotMatch(previewResult.content[0].text, /DRY-RUN|GECOR_ALLOW_SUBMISSION/);
      assert.equal(calls.upload.length, index, "preview must not upload");
      const args = { preview_token: preview.preview_token, confirm: true, human_confirmed: true };

      const accepted = await client.callTool({ name: "create_aviso_from_photo", arguments: args });
      assert.equal(accepted.isError, undefined, accepted.content[0].text);
      assert.equal(JSON.parse(accepted.content[0].text).phase, "submitted");
      assert.equal(calls.upload.length, index + 1);
      assert.equal(calls.upload[index], expectedPhotoDataUri);
      assert.equal(calls.submit.length, index + 1);
      assert.equal(calls.submit[index].desAveria, `fixture description ${index}`);

      const replay = await client.callTool({ name: "create_aviso_from_photo", arguments: args });
      assert.equal(replay.isError, true);
      assert.equal(calls.submit.length, index + 1);
    }
  } finally {
    await client.close();
    await server.close();
    if (previous === undefined) delete process.env.GECOR_ALLOW_SUBMISSION;
    else process.env.GECOR_ALLOW_SUBMISSION = previous;
  }
});
