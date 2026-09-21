import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A model server that says exactly what a test tells it to.
 *
 * The journeys that use it are about the application's behaviour around a model — the
 * routing it refuses to delegate, the replies it refuses to pass on, what a patient sees
 * when the model is down — and none of that can be asserted against a real model, whose
 * answers change between runs and whose presence on the machine is not this repository's
 * business. So the protocol is real, the server is a stub, and the test decides the reply.
 *
 * It binds 127.0.0.1 on purpose. That is also what lets the app boot with
 * TRIAGE_ENGINE=model and no BAA acknowledgement, which is itself under test: the same
 * URL on any other host must refuse to start.
 */

export type StubModel = {
  /** Origin only; the app is given the chat-completions path on top of it. */
  url: string;
  /** How many completions have been asked for, so a test can prove none was. */
  calls: number;
  /** The body of the most recent request, for asserting what was sent. */
  lastRequest: { messages?: { role: string; content: string }[] } | null;
  /** What the model replies to everything, until changed. */
  say: (content: string) => void;
  /** Respond with this status instead, as an outage would. */
  fail: (status: number) => void;
  stop: () => Promise<void>;
};

export async function startStubModel(): Promise<StubModel> {
  let content = 'Thanks for telling me. How long has that been going on?';
  let status = 200;

  const state = {
    calls: 0,
    lastRequest: null as StubModel['lastRequest'],
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      state.calls += 1;
      try {
        state.lastRequest = JSON.parse(Buffer.concat(chunks).toString()) as StubModel['lastRequest'];
      } catch {
        state.lastRequest = null;
      }

      if (status !== 200) {
        /* A body that echoes the request, as a real vendor's error does — the application
           must never surface or log it. */
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stub failure', echo: state.lastRequest } }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    get calls() {
      return state.calls;
    },
    get lastRequest() {
      return state.lastRequest;
    },
    say(next: string) {
      content = next;
      status = 200;
    },
    fail(next: number) {
      status = next;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
