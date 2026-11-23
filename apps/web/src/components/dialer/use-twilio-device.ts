"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Call, Device } from "@twilio/voice-sdk";
import { api } from "@/lib/api";

/** Twilio Voice SDK error codes → messages a non-technical user can act on. */
export function explainSdkError(err: { code?: number; message?: string }): string {
  switch (err?.code) {
    case 31401:
    case 31208:
    case 31402:
      return "The browser couldn't use your microphone. Allow microphone access for this site (click the icon in the address bar) and try again.";
    case 31204:
    case 31205:
    case 20101:
    case 20104:
      return "The calling session expired. Reload the page and try again.";
    case 31005:
    case 31009:
    case 53000:
      return "Lost connection to Twilio. Check your internet connection.";
    case 31486:
      return "The number is busy.";
    case 31480:
      return "Nobody answered.";
    default:
      return err?.message ? `Call error: ${err.message}` : "Something went wrong with the call.";
  }
}

/**
 * Owns the Twilio Device (browser phone). Loaded lazily on the client only, so the SDK
 * never runs during server rendering. Refreshes its token before it expires.
 */
export function useTwilioDevice() {
  const deviceRef = useRef<Device | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchToken = () => api<{ token: string }>("/voice/token", { method: "POST" }).then((r) => r.token);

  const ensureDevice = useCallback(async (): Promise<Device> => {
    if (deviceRef.current) return deviceRef.current;
    const { Device } = await import("@twilio/voice-sdk");
    const device = new Device(await fetchToken(), {
      codecPreferences: ["opus", "pcmu"] as Call.Codec[],
      closeProtection: "A call is in progress. Leaving this page will hang up.",
      appName: "ai-cloud-calling",
    });
    device.on("tokenWillExpire", async () => {
      try {
        device.updateToken(await fetchToken());
      } catch {
        /* next call will surface the error */
      }
    });
    device.on("error", (e) => setError(explainSdkError(e)));
    deviceRef.current = device;
    setReady(true);
    return device;
  }, []);

  useEffect(() => () => deviceRef.current?.destroy(), []);

  const connect = useCallback(
    async (callId: string) => {
      setError(null);
      const device = await ensureDevice();
      return device.connect({ params: { callId } });
    },
    [ensureDevice],
  );

  return { connect, ensureDevice, ready, error, setError };
}
