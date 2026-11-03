export class LiveChannel {
  constructor({ audio, request, onEvent, onError, onAudioBlocked }) {
    Object.assign(this, { audio, request, onEvent, onError, onAudioBlocked });
    this.cancelled = false;
  }
  async connect() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs HTTPS on your iPhone. Use a trusted HTTPS address.');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (this.cancelled) { this.cleanup(); return; }
    const pc = this.pc = new RTCPeerConnection();
    this.stream.getAudioTracks().forEach(track => pc.addTrack(track, this.stream));
    pc.ontrack = event => {
      if (this.cancelled) return;
      this.audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      this.audio.play().catch(() => this.onAudioBlocked());
    };
    pc.onconnectionstatechange = () => {
      if (!this.cancelled && ['failed', 'disconnected', 'closed'].includes(pc.connectionState)) this.onError(new Error('Voice connection lost. Your captured draft is still available. Engage a new channel when ready.'));
    };
    const events = this.events = pc.createDataChannel('oai-events');
    events.onmessage = ({ data }) => {
      if (this.cancelled) return;
      try {
        const event = JSON.parse(data);
        if (event.type === 'session.started') {
          this.request('/api/live/ready', {}).catch(error => this.onError(error));
        }
        this.onEvent(event);
      } catch { this.onError(new Error('The voice channel received an unreadable event.')); }
    };
    events.onclose = () => { if (!this.cancelled) this.onError(new Error('Voice channel closed. Session finalization may be unconfirmed.')); };
    const offer = await pc.createOffer();
    if (this.cancelled) return;
    await pc.setLocalDescription(offer);
    await this.waitForIce(pc);
    if (this.cancelled) return;
    const result = await this.request('/api/begin', { mode: 'live', sdp: pc.localDescription.sdp });
    if (this.cancelled) { await this.request('/api/stop', {}); return; }
    await pc.setRemoteDescription({ type: 'answer', sdp: result.sdp });
    if (!this.isStarted && !this.cancelled) this.startupTimer = setTimeout(() => this.onError(new Error('The voice channel did not start in time. Check account access and network connectivity.')), 30000);
  }
  started() { this.isStarted = true; clearTimeout(this.startupTimer); }
  waitForIce(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', listener); this.cancelIce = null; error ? reject(error) : resolve(); };
      const listener = () => { if (pc.iceGatheringState === 'complete') finish(); };
      const timer = setTimeout(() => finish(new Error('The microphone connection timed out. Try another network.')), 10000);
      this.cancelIce = () => finish();
      pc.addEventListener('icegatheringstatechange', listener);
    });
  }
  mute() {
    const muted = this.stream.getAudioTracks().some(track => track.enabled);
    this.stream.getAudioTracks().forEach(track => { track.enabled = !muted; });
    return muted;
  }
  cleanup() {
    this.cancelled = true;
    clearTimeout(this.startupTimer);
    this.cancelIce?.();
    this.stream?.getTracks().forEach(track => track.stop());
    this.events?.close(); this.pc?.close();
    this.audio.pause(); this.audio.srcObject = null;
  }
}
