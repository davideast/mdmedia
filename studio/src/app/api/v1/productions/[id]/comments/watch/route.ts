import { authorize, apiError } from "@/lib/api-auth";
import { adminDb } from "@/lib/firebase-admin";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Current-state synchronization, not a durable event log. Each reconnect starts fresh. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const caller = await authorize(request, "comments:read");
  if (caller instanceof Response) return caller;
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
    return apiError(404, "production_not_found", "Production not found.");
  const prod = (await adminDb().collection("productions").doc(id).get()).data();
  if (!prod || prod.ownerUid !== caller.uid)
    return apiError(404, "production_not_found", "Production not found.");
  const cut = new URL(request.url).searchParams.get("cut");
  if (cut && !prod.cuts.some((c: { id: string }) => c.id === cut))
    return apiError(404, "cut_not_found", "Version not found.");
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false,
        initial = false,
        last = "";
      const unsubscribers: Array<() => void> = [];
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const state: { threads: unknown[] | null; decisions: unknown[] | null } =
        { threads: null, decisions: null };
      cleanup = () => {
        if (closed) return;
        closed = true;
        for (const unsubscribe of unsubscribers) unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener("abort", abort);
      };
      const close = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* Already cancelled. */
        }
      };
      const abort = () => close();
      const enqueue = (text: string) => {
        if (closed) return;
        if ((controller.desiredSize ?? 0) < -20) {
          close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(text));
      };
      const emit = () => {
        if (closed || state.threads === null || state.decisions === null)
          return;
        const data = JSON.stringify({ productionId: id, ...state });
        if (data === last) return;
        last = data;
        enqueue(`event: ${initial ? "change" : "snapshot"}\ndata: ${data}\n\n`);
        initial = true;
      };
      const error = () => {
        enqueue(
          'event: error\ndata: {"code":"watch_interrupted","message":"Reconnect for the current review state."}\n\n',
        );
        close();
      };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) {
        close();
        return;
      }
      for (const collection of ["threads", "decisions"] as const) {
        const unsubscribe = adminDb()
          .collection(`productions/${id}/${collection}`)
          .where("ownerUid", "==", caller.uid)
          .onSnapshot((snapshot) => {
            state[collection] = snapshot.docs
              .map((doc) => {
                const { ownerUid: _, ...data } = doc.data();
                return { ...data, id: doc.id };
              })
              .filter(
                (data: Record<string, unknown>) =>
                  !cut ||
                  (collection === "threads"
                    ? (data.version as { cutId?: string })?.cutId === cut
                    : !(data.cutIds as string[] | undefined)?.length ||
                      (data.cutIds as string[]).includes(cut)),
              )
              .sort((a, b) => a.id.localeCompare(b.id));
            emit();
          }, error);
        if (closed) unsubscribe();
        else unsubscribers.push(unsubscribe);
      }
      if (!closed)
        heartbeat = setInterval(() => enqueue(": keepalive\n\n"), 15000);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
