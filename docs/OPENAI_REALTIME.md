# OpenAI Realtime configuration

> **Status:** implemented in Phase 4 (`apps/api/src/modules/ai/bridge.ts`). The exact session config was **accepted by the live OpenAI Realtime API** on 2026-11-23 (session.updated with pcmu in/out, marin, semantic_vad, gpt-4o-mini-transcribe, both tools). A real phone test is still pending.

## Chosen architecture: Twilio Media Streams ⇄ API ⇄ OpenAI Realtime (WebSocket)

```
Recipient's phone ⇄ Twilio (your US number) ⇄ wss /twilio/media-stream ⇄ Railway api ⇄ wss api.openai.com/v1/realtime
                                               μ-law 8 kHz, base64           (bridge)        model=gpt-realtime-2.1
```

1. The backend creates the outbound call with Twilio's REST API. The `from` is your US number, and the `url` points to `/webhooks/twilio/voice/ai`.
2. When the call is answered, that webhook returns `<Connect><Stream url="wss://…/twilio/media-stream">`.
3. The API opens a server-to-server WebSocket to OpenAI and bridges the audio in both directions. Both sides use **G.711 μ-law**, so no re-encoding is needed.
4. The API owns the call. It enforces the agent's max duration, writes transcripts, hangs up through Twilio's REST API, and records opt-outs in the Do Not Call list.

### Why not OpenAI SIP?
OpenAI also accepts calls over SIP (`sip:<proj_id>@sip.api.openai.com;transport=tls`, plus a `realtime.call.incoming` webhook). That would need **Twilio Elastic SIP Trunking**. Putting your US number on a SIP trunk takes it out of Programmable Voice. Then the same number can't easily serve browser (human) calls and AI calls from one dialer, and outbound AI calls would need extra routing. The Media Streams bridge keeps the one number working for both modes and gives the backend full control. SIP stays an option to revisit if audio latency turns out to be a problem.

### GPT-Live
OpenAI now also offers **GPT-Live** (`gpt-live-1.1`, `wss://api.openai.com/v1/live/sessions`, which starts with `session.start`). It's a newer full-duplex voice product. Phase 4 will compare it with `gpt-realtime-2.1` on a real test call before deciding. The bridge will be written so the model/protocol adapter can be swapped.

## Connection (server-to-server only)
- URL: `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1`
- Header: `Authorization: Bearer <OpenAI API key>`. The key is decrypted from the database on the server and is **never** sent to the browser.
- Optional header `OpenAI-Safety-Identifier`: the org ID, hashed.
- The first server event is `session.created`. After it, the bridge sends `session.update`.

## Session configuration (built from the AI Agent record, not hard-coded)
```jsonc
{
  "type": "session.update",
  "session": {
    "type": "realtime",
    "model": "gpt-realtime-2.1",
    "output_modalities": ["audio"],
    "instructions": "<agent.system_instructions + conversation_rules + call_ending_instructions + mandatory AI disclosure>",
    "audio": {
      "input":  { "format": { "type": "audio/pcmu" }, "turn_detection": { "type": "semantic_vad" } },
      "output": { "format": { "type": "audio/pcmu" }, "voice": "<agent.voice>" }
    }
  }
}
```
- **Voices:** `alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar`. OpenAI recommends `marin` / `cedar`. The voice can't change after the model has spoken once in a session.
- **Disclosure:** the bridge always adds an instruction that the assistant must say it's an AI at the start of the call. Agent settings can't remove it.

## Events the bridge handles

| Direction | Event | Action |
|---|---|---|
| Twilio → OpenAI | Twilio `media` | `input_audio_buffer.append` (base64 μ-law) |
| OpenAI → Twilio | `response.output_audio.delta` | Twilio `media` message to the caller |
| Caller interrupts | `input_audio_buffer.speech_started` | Send Twilio `clear` (drops buffered AI audio) and `conversation.item.truncate` at the played position |
| Transcript (AI) | `response.output_audio_transcript.done` | Insert `call_transcripts` row with speaker `ai` and push a live event |
| Transcript (caller) | input transcription event (see open items) | Insert row with speaker `caller` |
| Errors | `error` | Log, write `call_events`, end gracefully |

## Limits and cost
- A Realtime session lasts at most **60 minutes**. Agent `max_call_duration_sec` is capped at 3600 in the database.
- Pricing for `gpt-realtime-2.1` on the model page (2026-11-23), **per 1M tokens**: audio input $32 (cached $0.40), audio output $64; text input $4, output $24.
  OpenAI doesn't publish a per-minute price. The Usage page will record the **token counts reported in `response.done`** and show the cost as an *estimate*, kept separate from billed amounts.
- Default rate limits depend on your OpenAI usage tier. Bulk campaign concurrency (max 10 per campaign) is well below them.

## What you need to provide (Phase 2/4, entered in the dashboard)
- **OpenAI API key:** https://platform.openai.com → **API keys** → *Create new secret key*. Use a project-scoped key, ideally from a project made only for this app.
- **Project ID** (`proj_…`): only needed if we later switch to SIP.
- The account needs billing set up and access to the Realtime models.

## Open items
- [x] `audio/pcmu` takes no `rate`. Confirmed in the API schema and accepted live.
- [x] Caller transcription: `session.audio.input.transcription = { model: "gpt-4o-mini-transcribe" }`, delivered as `conversation.item.input_audio_transcription.completed`.
- [x] Media stream security: the call id goes in the path (`/twilio/media-stream/<callId>`, since Stream URLs can't take query strings). The handshake checks the Twilio signature, and a one-time `<Parameter name="token">` is accepted only once.
- [x] Tools: `end_call` hangs up after the goodbye audio has finished playing (Twilio mark). `add_to_do_not_call` writes to the DNC list immediately.
- [ ] `semantic_vad` vs `server_vad` on real phone audio (latency, false interruptions).
- [ ] A community report of `server_error` on Twilio pcmu sessions. Reproduce it on a test call before going live.
- [ ] Final model choice: `gpt-realtime-2.1` vs `gpt-realtime-2.1-mini` vs GPT-Live.

Sources: OpenAI docs — Realtime WebSocket guide, Realtime inputs & outputs, Models catalog / gpt-realtime-2.1, Realtime SIP guide (developers.openai.com, read 2026-11-23).
