import { Server } from "node:http";
import { serve } from "@hono/node-server";
import { app } from "./app";
import { logger } from "./logger";

const port = Number(process.env.PORT || 10256);

const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, "api-server listening");
});

// Must exceed the ALB idle timeout (65s) or the ALB reuses connections
// Node has already closed → sporadic 502s.
if (server instanceof Server) {
  server.keepAliveTimeout = 70000;
  server.headersTimeout = 71000;
}
