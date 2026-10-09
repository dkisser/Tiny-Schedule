/**
 * Local SSE mock for exercising the Rust bridge during the Tauri port.
 * Pushes `CHUNK_COUNT` `data:` frames one second apart so a broken bridge —
 * one that buffers the whole body — shows up as a single burst instead of
 * incremental delivery.
 *
 * Usage: bun run sse-mock [--port 8788] [--chunks 5] [--delay 1000]
 */

interface Options {
  port: number;
  chunkCount: number;
  delayMs: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { port: 8788, chunkCount: 5, delayMs: 1000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = Number(argv[i + 1]);
    if (Number.isNaN(value)) continue;
    if (flag === '--port') options.port = value;
    if (flag === '--chunks') options.chunkCount = value;
    if (flag === '--delay') options.delayMs = value;
    i += 1;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const encoder = new TextEncoder();

Bun.serve({
  port: options.port,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    // The probe page runs inside the webview, whose console this terminal
    // cannot read; it posts its log here so the evidence lands in a file.
    if (url.pathname === '/report' && request.method === 'POST') {
      const line = (await request.text()).trim();
      console.log(`[sse-mock] PROBE ${line}`);
      return new Response('ok');
    }
    if (url.pathname !== '/sse') {
      return new Response('not found', { status: 404 });
    }

    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('retry: 1000\n\n'));
        for (let i = 1; i <= options.chunkCount; i += 1) {
          // Sleep in slices so an aborted stream stops promptly instead of
          // running the whole loop first.
          for (let waited = 0; waited < options.delayMs && !cancelled; waited += 50) {
            await Bun.sleep(50);
          }
          if (cancelled) break;
          const frame = `data: chunk-${i}/${options.chunkCount} at ${new Date().toISOString()}\n\n`;
          console.log(`[sse-mock] send ${frame.trim()}`);
          controller.enqueue(encoder.encode(frame));
        }
        if (!cancelled) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          console.log('[sse-mock] stream complete');
        }
        controller.close();
      },
      cancel() {
        cancelled = true;
        console.log('[sse-mock] client cancelled');
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  },
});

console.log(
  `[sse-mock] listening on http://127.0.0.1:${options.port}/sse ` +
    `(${options.chunkCount} chunks, ${options.delayMs}ms apart)`,
);
