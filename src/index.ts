#!/usr/bin/env node
import { runServer } from "./server.js";

runServer().catch((error) => {
  console.error("Error fatal en el servidor MCP:", error);
  process.exit(1);
});
