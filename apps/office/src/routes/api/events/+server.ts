// The page's one live line: table changes and who is working, as server-sent
// events. Pushed when something happens, silent otherwise.
import { bus, listen, type OfficeEvent } from '#lib/server/events.ts';
import { pageClosed, pageOpened } from '#lib/server/health.ts';
import { chatting, inProgress } from '#lib/server/staff.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request }) => {
  listen();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (e: OfficeEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      send({ type: 'working', chatting: chatting(), inProgress: inProgress() });
      bus.on('event', send);
      pageOpened();
      // Both the abort and cancel call it, so the page count drops once.
      let open = true;
      stop = () => {
        bus.off('event', send);
        if (open) pageClosed();
        open = false;
      };
      request.signal.addEventListener('abort', () => {
        stop();
        try {
          controller.close();
        } catch {
          // Already closed by the browser.
        }
      });
    },
    cancel() {
      stop();
    }
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }
  });
};
