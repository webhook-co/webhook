import { SERVICE_NAME } from "@webhook-co/shared";

// Placeholder webhook engine Worker. Real ingest/verify/deliver logic (Workers + Durable
// Objects) lands here. Handlers stay thin: validate -> delegate -> respond, and ACK fast.
export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response(`${SERVICE_NAME}:engine ok`, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler;
