import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../dist/server.js";

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

test("blocked MCP submission preserves the exact preview for later opt-in", async () => {
  const previous = process.env.GECOR_ALLOW_SUBMISSION;
  delete process.env.GECOR_ALLOW_SUBMISSION;
  const calls = { upload: 0, submit: 0, uploadedPhoto: undefined };
  const fakeClient = {
    ayuntamientoID: 268,
    getPetitionerIdentity() { return { Nombre: "Ada", Email: "ada@example.test", Movil: "123", CiudadanoID: 9 }; },
    async getAyuntamiento() { return { AyuntamientoID: 268, Nombre: "Example" }; },
    async guardarFotoBase64(dataUri) { calls.upload++; calls.uploadedPhoto = dataUri; return "fixture-photo"; },
    async nuevaIncidencia() { calls.submit++; return { accepted: true }; },
  };
  const server = createMcpServer(fakeClient);
  const client = new Client({ name: "test-client", version: "1.0" });
  const [clientTransport, serverTransport] = linkedTransports();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const previewResult = await client.callTool({
      name: "create_aviso_preview",
      arguments: {
        description: "fixture description", tipoElementoID: 1, tipoIncID: 2,
        lat: 36, lng: -6, image_base64: Buffer.from("fixture image").toString("base64"),
      },
    });
    const preview = JSON.parse(previewResult.content[0].text);
    const expectedPhotoDataUri = `data:image/png;base64,${Buffer.from("fixture image").toString("base64")}`;
    const args = { preview_token: preview.preview_token, confirm: true, human_confirmed: true };

    for (const disabledValue of [undefined, "false"]) {
      if (disabledValue === undefined) delete process.env.GECOR_ALLOW_SUBMISSION;
      else process.env.GECOR_ALLOW_SUBMISSION = disabledValue;
      const blocked = await client.callTool({ name: "create_aviso", arguments: args });
      assert.equal(blocked.isError, true);
      assert.match(blocked.content[0].text, /GECOR_ALLOW_SUBMISSION=true/);
      assert.deepEqual(calls, { upload: 0, submit: 0, uploadedPhoto: undefined });
    }

    process.env.GECOR_ALLOW_SUBMISSION = "true";
    const accepted = await client.callTool({ name: "create_aviso", arguments: args });
    assert.equal(accepted.isError, undefined);
    assert.deepEqual(calls, { upload: 1, submit: 1, uploadedPhoto: expectedPhotoDataUri });
  } finally {
    await client.close();
    await server.close();
    if (previous === undefined) delete process.env.GECOR_ALLOW_SUBMISSION;
    else process.env.GECOR_ALLOW_SUBMISSION = previous;
  }
});
