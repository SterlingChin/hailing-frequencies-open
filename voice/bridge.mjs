const OPEN = 1;
const CLOSED = 3;
const STARTUP_AUDIO_BYTES = 8_000; // One second of mono PCMU at 8 kHz.
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_OUTPUT_AUDIO_BYTES = 64 * 1024;
const MAX_TOOL_CALLS = 64;
const MODEL_CLOSE_REASONS = new Set([
  'close_requested', 'expired', 'content', 'remote_hangup', 'connection_lost',
]);

function parseMessage(data) {
  if (typeof data !== 'string' && !Buffer.isBuffer(data)) throw new Error('invalid_message');
  if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES) throw new Error('invalid_message');
  const value = JSON.parse(data.toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_message');
  return value;
}

function audioBytes(value, limit) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(limit / 3) * 4
      || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid_audio');
  }
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || decoded.length > limit || decoded.toString('base64') !== value) throw new Error('invalid_audio');
  return decoded.length;
}

/** Bridge an authenticated Twilio Media Stream to a primary GPT-Live socket.
 * Socket factory and repair lookup are injected so offline tests need no keys.
 * Diagnostics deliberately contain no audio, transcripts, IDs, or error text.
 */
export function attachBridge(twilioSocket, {
  createModelSocket,
  sessionConfig,
  lookupRepair,
  callTools,
  welcome,
  maxSessionMs = 120_000,
  startupTimeoutMs = 10_000,
  closeTimeoutMs = 5_000,
  onEvent = () => {},
}) {
  if (typeof createModelSocket !== 'function' || typeof lookupRepair !== 'function') throw new TypeError('Missing bridge dependencies');
  if (sessionConfig?.model !== 'gpt-live-1' || sessionConfig?.audio?.format?.type !== 'audio/pcmu'
      || sessionConfig?.audio?.format?.rate !== 8000) throw new TypeError('Bridge requires gpt-live-1 with 8 kHz PCMU audio');
  for (const value of [maxSessionMs, startupTimeoutMs, closeTimeoutMs]) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError('Bridge timeouts must be positive');
  }
  if (welcome != null && (typeof welcome !== 'string' || welcome.length > 2000)) throw new TypeError('Invalid welcome instruction');

  const stats = {
    started: false,
    audioInputFrames: 0, audioInputBytes: 0,
    audioOutputFrames: 0, audioOutputBytes: 0,
    startupDroppedFrames: 0, startupDroppedBytes: 0,
    toolRequests: 0, toolSuccesses: 0, toolFailures: 0,
    finalized: false, usageSeconds: null, finalUsageSeconds: null,
    closeReason: null, modelCloseReason: null, backendFailureReason: null,
    modelTransportClosed: false, twilioTransportClosed: false,
  };
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  let modelSocket;
  let streamSid;
  let startSent = false;
  let stopping = false;
  let finishing = false;
  let ended = false;
  let startupAudio = [];
  let startupBytes = 0;
  let sessionTimer;
  let closeTimer;
  const toolCalls = new Set();
  const startupTimer = setTimeout(() => requestStop('startup_timeout'), startupTimeoutMs);

  function notify(type) {
    try { onEvent({ type, ...stats }); } catch { /* Diagnostics must not affect the call. */ }
  }

  function closeTransport(socket, force = false) {
    if (!socket || socket.readyState === CLOSED) return;
    try { socket.close(); } catch { /* Force cleanup below when supported. */ }
    if (force && socket.readyState !== CLOSED && typeof socket.terminate === 'function') {
      try { socket.terminate(); } catch { /* No additional work is possible. */ }
    }
  }

  function complete() {
    if (ended) return;
    ended = true;
    clearTimeout(closeTimer);
    notify('finished');
    // Memory cleanup does not hold the audio callback or transport shutdown open.
    Promise.resolve().then(() => callTools?.end()).catch(() => {}).finally(() => resolveDone({ ...stats }));
  }

  function completeWhenTransportsClosed() {
    if (!finishing) return;
    if ((!modelSocket || stats.modelTransportClosed) && stats.twilioTransportClosed) complete();
  }

  function finish() {
    if (finishing || ended) return;
    finishing = true;
    stopping = true;
    clearTimeout(startupTimer);
    clearTimeout(sessionTimer);
    clearTimeout(closeTimer);
    startupAudio = [];
    startupBytes = 0;
    closeTransport(twilioSocket, true);
    closeTransport(modelSocket, true);
    completeWhenTransportsClosed();
    // Real WebSocket close events are asynchronous. Report observed closure,
    // while keeping cleanup bounded even if a transport never acknowledges it.
    if (!ended) closeTimer = setTimeout(complete, closeTimeoutMs);
  }

  function send(socket, event) {
    if (socket?.readyState !== OPEN || (socket.bufferedAmount ?? 0) > MAX_MESSAGE_BYTES) return false;
    try { socket.send(JSON.stringify(event)); return true; } catch { return false; }
  }

  function requestStop(reason) {
    if (stopping || ended) return done;
    stopping = true;
    stats.closeReason = reason;
    clearTimeout(startupTimer);
    clearTimeout(sessionTimer);
    startupAudio = [];
    startupBytes = 0;
    closeTransport(twilioSocket);
    notify('stopping');
    if (startSent && send(modelSocket, { type: 'session.close' })) {
      closeTimer = setTimeout(finish, closeTimeoutMs);
    } else {
      finish();
    }
    return done;
  }

  function forwardInput(audio, bytes) {
    if (!send(modelSocket, { type: 'session.input_audio.append', audio })) {
      requestStop('model_send_failed');
      return;
    }
    stats.audioInputFrames += 1;
    stats.audioInputBytes += bytes;
  }

  function recordUsage(event, final = false) {
    const seconds = event.usage?.seconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
      // Every event is cumulative; adding updates would overcount usage.
      stats.usageSeconds = seconds;
      if (final) stats.finalUsageSeconds = seconds;
    }
  }

  function handleTool(item) {
    if (item?.type !== 'function_call' || item.status !== 'completed') return;
    if (typeof item.call_id !== 'string' || !item.call_id.length || item.call_id.length > 256) {
      requestStop('invalid_tool_call');
      return;
    }
    if (toolCalls.has(item.call_id)) return;
    if (toolCalls.size >= MAX_TOOL_CALLS) {
      requestStop('tool_limit');
      return;
    }
    toolCalls.add(item.call_id);
    stats.toolRequests += 1;
    notify('tool_requested');

    // Never await tool work in the socket callback: audio keeps flowing.
    void (async () => {
      let result;
      try {
        if (!callTools && item.name !== 'lookup_repair') {
          result = { ok: false, error: { code: 'unsupported_tool', message: 'This tool is not available.' } };
        } else {
          let args;
          try {
            if (typeof item.arguments !== 'string' || Buffer.byteLength(item.arguments) > 8192) throw new Error();
            args = JSON.parse(item.arguments);
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
          } catch {
            result = { ok: false, error: { code: 'invalid_arguments', message: 'Tool arguments are invalid.' } };
          }
          if (!result) result = callTools ? await callTools.handle(item.name, args) : await lookupRepair(args);
        }
        if (result === undefined) throw new Error('Missing tool result');
        const output = JSON.stringify(result);
        if (!output || Buffer.byteLength(output) > 32 * 1024) throw new Error('Invalid tool result');
        result = { value: result, output };
      } catch {
        const value = { ok: false, error: { code: 'repair_lookup_failed', message: 'Repair lookup failed.' } };
        result = { value, output: JSON.stringify(value) };
      }
      if (stopping || ended) return;
      if (result.value?.ok === false) stats.toolFailures += 1;
      else stats.toolSuccesses += 1;
      if (!send(modelSocket, {
        type: 'response.item.create',
        item: { type: 'function_call_output', call_id: item.call_id, output: result.output },
      }) || !send(modelSocket, { type: 'response.create' })) {
        requestStop('model_send_failed');
        return;
      }
      notify('tool_finished');
    })();
  }

  function onModelMessage(data, isBinary = false) {
    if (finishing || ended) return;
    let event;
    try {
      if (isBinary) throw new Error();
      event = parseMessage(data);
    } catch { requestStop('invalid_model_message'); return; }
    if (event.type === 'session.closed') {
      stats.finalized = true;
      stats.modelCloseReason = MODEL_CLOSE_REASONS.has(event.reason) ? event.reason : 'unknown';
      recordUsage(event, true);
      stats.closeReason ??= 'model_session_closed';
      finish();
      return;
    }
    if (event.type === 'session.usage.updated') {
      recordUsage(event);
      return;
    }
    if (stopping) return;
    if (event.type === 'error') { requestStop('model_error'); return; }
    if (event.type === 'session.started') {
      if (!startSent || stats.started) { requestStop('invalid_model_sequence'); return; }
      stats.started = true;
      clearTimeout(startupTimer);
      if (welcome && (!send(modelSocket, {
        type: 'session.instructions.append', delegation_id: null,
        content: `Your first spoken line on this call is, verbatim: ${JSON.stringify(welcome)}`,
      }) || !send(modelSocket, { type: 'session.commentary.append', delegation_id: null, content: welcome }))) {
        requestStop('model_send_failed');
        return;
      }
      if (callTools) void callTools.startupInstruction().then(content => {
        if (!stopping && !ended && !send(modelSocket, { type: 'session.instructions.append', delegation_id: null, content })) requestStop('model_send_failed');
      }).catch(() => {});
      const buffered = startupAudio;
      startupAudio = [];
      startupBytes = 0;
      for (const frame of buffered) {
        if (stopping) break;
        forwardInput(frame.audio, frame.bytes);
      }
      notify('started');
      return;
    }
    if (event.type === 'session.output_audio.delta') {
      if (!stats.started) { requestStop('invalid_model_sequence'); return; }
      let bytes;
      try { bytes = audioBytes(event.delta, MAX_OUTPUT_AUDIO_BYTES); }
      catch { requestStop('invalid_model_audio'); return; }
      if (!send(twilioSocket, { event: 'media', streamSid, media: { payload: event.delta } })) {
        requestStop('twilio_send_failed');
        return;
      }
      stats.audioOutputFrames += 1;
      stats.audioOutputBytes += bytes;
    } else if (event.type === 'response.event') {
      if (!stats.started) { requestStop('invalid_model_sequence'); return; }
      if (['error', 'response.failed', 'response.incomplete'].includes(event.event?.type)) {
        stats.backendFailureReason = event.event.type;
        requestStop('backend_failed');
        return;
      }
      if (event.event?.type === 'response.output_item.done') handleTool(event.event.item);
    }
  }

  function connectModel() {
    try {
      modelSocket = createModelSocket();
      modelSocket.on('message', onModelMessage);
      modelSocket.on('close', () => {
        stats.modelTransportClosed = true;
        completeWhenTransportsClosed();
        if (finishing) return;
        if (ended) return;
        stats.closeReason ??= 'model_disconnect';
        finish();
      });
      modelSocket.on('error', () => requestStop('model_transport_error'));
      const onOpen = () => {
        if (stopping || ended) { closeTransport(modelSocket, true); return; }
        if (startSent) return;
        startSent = send(modelSocket, { type: 'session.start', session: sessionConfig });
        if (!startSent) requestStop('model_send_failed');
      };
      modelSocket.on('open', onOpen);
      if (modelSocket.readyState === OPEN) onOpen();
    } catch { requestStop('model_connect_failed'); }
  }

  twilioSocket.on('message', (data, isBinary = false) => {
    if (stopping || ended) return;
    let event;
    try {
      if (isBinary) throw new Error();
      event = parseMessage(data);
    } catch { requestStop('invalid_twilio_message'); return; }
    if (event.event === 'connected') return;
    if (event.event === 'start') {
      const start = event.start;
      if (streamSid || typeof start?.streamSid !== 'string' || !/^MZ[a-zA-Z0-9]{1,62}$/.test(start.streamSid)
          || (event.streamSid !== undefined && event.streamSid !== start.streamSid)
          || start.mediaFormat?.encoding !== 'audio/x-mulaw' || start.mediaFormat?.sampleRate !== 8000
          || start.mediaFormat?.channels !== 1) {
        requestStop('invalid_twilio_start');
        return;
      }
      streamSid = start.streamSid;
      sessionTimer = setTimeout(() => requestStop('max_duration'), maxSessionMs);
      connectModel();
      return;
    }
    if (event.event === 'media' || event.event === 'stop' || event.event === 'mark' || event.event === 'dtmf') {
      if (!streamSid || event.streamSid !== streamSid) { requestStop('invalid_stream'); return; }
    }
    if (event.event === 'stop') { requestStop('twilio_stop'); return; }
    if (event.event !== 'media') return;
    if (event.media?.track && event.media.track !== 'inbound') { requestStop('invalid_audio_track'); return; }
    let bytes;
    try { bytes = audioBytes(event.media?.payload, STARTUP_AUDIO_BYTES); }
    catch { requestStop('invalid_twilio_audio'); return; }
    if (stats.started) {
      forwardInput(event.media.payload, bytes);
    } else {
      startupAudio.push({ audio: event.media.payload, bytes });
      startupBytes += bytes;
      while (startupBytes > STARTUP_AUDIO_BYTES) {
        const dropped = startupAudio.shift();
        startupBytes -= dropped.bytes;
        stats.startupDroppedFrames += 1;
        stats.startupDroppedBytes += dropped.bytes;
      }
    }
  });
  twilioSocket.on('close', () => {
    stats.twilioTransportClosed = true;
    completeWhenTransportsClosed();
    requestStop('twilio_disconnect');
  });
  twilioSocket.on('error', () => requestStop('twilio_transport_error'));

  return { done, stop: () => requestStop('requested') };
}
