import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface WireMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface WireBody {
  model: string;
  messages: WireMessage[];
  tools?: unknown[];
  system?: unknown;
  [key: string]: unknown;
}

export interface Capture {
  body: WireBody;
  headers: IncomingHttpHeaders;
  url: string;
  at: number;
}

export interface StubReply {
  text?: string;
  fail?: boolean;
}

export interface HttpStub {
  captures: Capture[];
  baseUrl: string;
  close: () => Promise<void>;
}

export async function httpStub(
  plan: (capture: Capture, index: number) => StubReply = () => ({}),
): Promise<HttpStub> {
  const captures: Capture[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const capture: Capture = {
      body: JSON.parse(raw) as WireBody,
      headers: request.headers,
      url: request.url ?? "",
      at: Date.now(),
    };
    captures.push(capture);
    const index = captures.length - 1;
    const reply = plan(capture, index);

    if (reply.fail) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "fixture provider failure",
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    sendOpenAiSse(response, reply);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    captures,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sendOpenAiSse(response: ServerResponse, reply: StubReply): void {
  const text = reply.text ?? "fixture answer";
  response.write(
    `data: ${JSON.stringify({
      id: "fixture",
      object: "chat.completion.chunk",
      model: "fixture",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "fixture",
      object: "chat.completion.chunk",
      model: "fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 4,
        total_tokens: 104,
      },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

export function extractSystemText(capture: Capture): string {
  const systemMessages = capture.body.messages.filter(
    (m) => m.role === "system",
  );
  return systemMessages
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
}
