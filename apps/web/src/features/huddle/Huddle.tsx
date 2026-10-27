import { createSignal, For, onCleanup, Show } from "solid-js";
import { Room, RoomEvent, Track, type RemoteTrack, type RemoteParticipant } from "livekit-client";
import { authState } from "../../lib/auth-store";

// -----------------------------------------------------------------------
// Huddle.tsx - integrated voice & video calls.
//
// This is honestly a scaffold: real audio/video requires a running LiveKit
// deployment (self-hosted or LiveKit Cloud), documented separately in
// infra/docker-compose.yml, plus a server-side `POST /livekit/token`
// endpoint that apps/api doesn't implement yet (it's outside the
// documented GraphQL contract - reconcile once it exists). If
// VITE_LIVEKIT_URL is unset, this component renders a clear "not
// configured" state instead of attempting a connection or crashing.
//
// INTEGRATION ASSUMPTIONS (reconcile against the real backend):
//   - `POST {API_URL}/livekit/token` (a plain REST endpoint, NOT GraphQL,
//     per the task brief) accepts `{ workspaceId, channelId }` as a JSON
//     body with the usual `Authorization: Bearer <accessToken>` header,
//     and returns `{ token: string }` - a LiveKit access token scoped to
//     a room for that channel.
//   - The LiveKit room name is assumed to be `${workspaceId}:${channelId}`
//     server-side; this client never needs to know the exact room name,
//     only the token, but it's documented here for whoever implements the
//     token endpoint.
// -----------------------------------------------------------------------

type HuddleStatus = "idle" | "connecting" | "connected" | "error";

export default function Huddle(props: { workspaceId: string; channelId: string; apiUrl: string }) {
  const livekitUrl: string | undefined = (import.meta as any).env?.VITE_LIVEKIT_URL || undefined;

  const [status, setStatus] = createSignal<HuddleStatus>("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [participants, setParticipants] = createSignal<string[]>([]);
  let room: Room | undefined;
  let mediaContainer: HTMLDivElement | undefined;

  onCleanup(() => {
    void room?.disconnect();
  });

  async function fetchLiveKitToken(): Promise<string> {
    const res = await fetch(`${props.apiUrl.replace(/\/$/, "")}/livekit/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authState().accessToken ?? ""}`,
      },
      body: JSON.stringify({ workspaceId: props.workspaceId, channelId: props.channelId }),
    });
    if (!res.ok) {
      throw new Error(`Token endpoint returned ${res.status}`);
    }
    const json = (await res.json()) as { token: string };
    return json.token;
  }

  function attachRemoteTrack(track: RemoteTrack, participant: RemoteParticipant) {
    const el = track.attach();
    el.dataset.participantId = participant.identity;
    mediaContainer?.appendChild(el);

    // *** Spatial audio hook point (documented, not wired) ***
    // Once this app tracks each participant's on-canvas position (see
    // Whiteboard.tsx's `awareness.setLocalStateField("position", {x, y})`
    // broadcast), the attenuation for this participant's audio track would
    // be computed right here, e.g.:
    //
    //   if (track.kind === Track.Kind.Audio) {
    //     const audioCtx = new AudioContext();
    //     const source = audioCtx.createMediaStreamSource(track.mediaStream!);
    //     const gainNode = audioCtx.createGain();
    //     source.connect(gainNode).connect(audioCtx.destination);
    //     gainNode.gain.value = computeGain(myPosition, participantPosition);
    //     // ...then update gainNode.gain.value on every position update.
    //   }
    //
    // See src/features/spatial-audio/gain.ts for `computeGain` itself,
    // which is fully implemented and unit-tested independent of this
    // wiring.
  }

  function detachRemoteTrack(track: RemoteTrack) {
    track.detach().forEach((el) => el.remove());
  }

  async function joinHuddle() {
    if (!livekitUrl) {
      setError("LiveKit server not configured (VITE_LIVEKIT_URL is unset).");
      return;
    }

    setStatus("connecting");
    setError(null);

    try {
      const token = await fetchLiveKitToken();
      room = new Room();

      room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        attachRemoteTrack(track, participant);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        detachRemoteTrack(track);
      });
      room.on(RoomEvent.ParticipantConnected, () => refreshParticipants());
      room.on(RoomEvent.ParticipantDisconnected, () => refreshParticipants());
      room.on(RoomEvent.Disconnected, () => {
        setStatus("idle");
        setParticipants([]);
      });

      await room.connect(livekitUrl, token);
      await room.localParticipant.setMicrophoneEnabled(true);
      await room.localParticipant.setCameraEnabled(true);

      refreshParticipants();
      setStatus("connected");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Failed to join huddle");
      await room?.disconnect();
      room = undefined;
    }
  }

  function refreshParticipants() {
    if (!room) return;
    const names = Array.from(room.remoteParticipants.values()).map((participant) => participant.identity);
    setParticipants(names);
  }

  async function leaveHuddle() {
    await room?.disconnect();
    room = undefined;
    setStatus("idle");
    setParticipants([]);
    if (mediaContainer) mediaContainer.innerHTML = "";
  }

  return (
    <div class="huddle">
      <Show
        when={livekitUrl}
        fallback={
          <div class="huddle__unconfigured">
            LiveKit server not configured. Set VITE_LIVEKIT_URL to enable voice/video huddles.
          </div>
        }
      >
        <div class="huddle__controls">
          <Show when={status() === "idle" || status() === "error"}>
            <button onClick={joinHuddle}>Join Huddle</button>
          </Show>
          <Show when={status() === "connecting"}>
            <button disabled>Connecting…</button>
          </Show>
          <Show when={status() === "connected"}>
            <button onClick={leaveHuddle}>Leave Huddle</button>
            <span class="huddle__participant-count">
              {participants().length + 1} in call
            </span>
          </Show>
        </div>

        <Show when={error()}>
          <div class="huddle__error">{error()}</div>
        </Show>

        <div class="huddle__media" ref={mediaContainer} />

        <Show when={status() === "connected"}>
          <ul class="huddle__participants">
            <For each={participants()}>{(name) => <li>{name}</li>}</For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}
