"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export interface RealtimeEvent<T = Record<string, unknown>> {
  type: string;
  data: T;
  at?: string;
}

/**
 * Live updates from the API over WebSocket. Fetches a 60-second ticket through the
 * same-origin proxy, connects directly to the API (Vercel can't proxy WebSockets),
 * and reconnects with backoff.
 */
export function useRealtime(onEvent: (e: RealtimeEvent) => void) {
  const handler = useRef(onEvent);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    handler.current = onEvent;
  });

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function connect() {
      if (stopped) return;
      try {
        const { url, ticket } = await api<{ url: string; ticket: string }>("/realtime/ticket", { method: "POST" });
        // In local dev the API's public URL may be a tunnel; the browser can always use it.
        ws = new WebSocket(`${url}?ticket=${encodeURIComponent(ticket)}`);
        ws.onopen = () => {
          attempt = 0;
          setConnected(true);
        };
        ws.onmessage = (m) => {
          try {
            handler.current(JSON.parse(m.data));
          } catch {
            /* ignore malformed */
          }
        };
        ws.onclose = () => {
          setConnected(false);
          schedule();
        };
      } catch {
        schedule();
      }
    }
    function schedule() {
      if (stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt++);
      timer = setTimeout(connect, delay);
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { connected };
}
