/**
 * TeleprompterMedia - Frontend Media Acquisition, Stream Management, and Audio Encoding Engine.
 *
 * Encapsulates:
 * 1. Audio acquisition, device enumeration, label probing, and external mic constraint configuration.
 * 2. Web Audio graph management (AudioContext lifecycle, AnalyserNode for VU metering).
 * 3. 16 kHz linear downsampling pipeline for real-time Whisper ASR streaming over WebSocket.
 * 4. Camera acquisition and video element lifecycle.
 * 5. MediaRecorder session capture with MIME negotiation.
 * 6. Pure client-side audio encoding (RIFF/WAV binary generation & LAME MP3 encoding).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node.js / CommonJS
    module.exports = factory();
  } else {
    // Browser global
    root.TeleprompterMedia = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // =========================================================================
  // Pure Math, Signal Processing, and Binary Encoding Utilities (AudioMath)
  // =========================================================================

  /**
   * Resamples raw audio samples to 16,000 Hz mono PCM using linear interpolation.
   *
   * @param {Float32Array|number[]} raw - Input audio samples
   * @param {number} inputSampleRate - Current sample rate of input (e.g. 44100, 48000)
   * @returns {Float32Array} Downsampled audio at 16,000 Hz
   */
  function resampleTo16k(raw, inputSampleRate) {
    if (!raw || raw.length === 0) return new Float32Array(0);
    if (!inputSampleRate || inputSampleRate === 16000) {
      return raw instanceof Float32Array ? raw.slice() : new Float32Array(raw);
    }

    const ratio = inputSampleRate / 16000;
    const outLen = Math.floor(raw.length / ratio);
    if (outLen < 1) return new Float32Array(0);

    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * ratio;
      const idx0 = Math.floor(srcPos);
      const idx1 = Math.min(raw.length - 1, idx0 + 1);
      const frac = srcPos - idx0;
      out[i] = raw[idx0] * (1 - frac) + raw[idx1] * frac;
    }
    return out;
  }

  /**
   * Converts Float32 audio samples in [-1.0, 1.0] to 16-bit signed PCM Int16Array.
   */
  function floatToInt16(floatArr) {
    if (!floatArr) return new Int16Array(0);
    const int16 = new Int16Array(floatArr.length);
    for (let i = 0; i < floatArr.length; i++) {
      const s = Math.max(-1, Math.min(1, floatArr[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }

  /**
   * Generates a standard RIFF/WAV binary ArrayBuffer or Blob from an AudioBuffer.
   *
   * @param {AudioBuffer|object} audioBuffer - Standard Web Audio AudioBuffer
   * @param {boolean} returnArrayBuffer - If true, returns ArrayBuffer directly (for Node/tests)
   * @returns {Blob|ArrayBuffer}
   */
  function audioBufferToWav(audioBuffer, returnArrayBuffer = false) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const length = audioBuffer.length;
    const byteRate = sampleRate * blockAlign;
    const dataSize = length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channelData.push(audioBuffer.getChannelData(ch));
    }

    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channelData[ch][i];
        sample = Math.max(-1, Math.min(1, sample));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, intSample, true);
        offset += 2;
      }
    }

    if (returnArrayBuffer || typeof Blob === 'undefined') {
      return buffer;
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  /**
   * Encodes an AudioBuffer into MP3 via lamejs.
   */
  function audioBufferToMp3(audioBuffer, kbps = 192, lameEncoder = null) {
    const encoderLib = lameEncoder || (typeof lamejs !== 'undefined' ? lamejs : null);
    if (!encoderLib || !encoderLib.Mp3Encoder) {
      throw new Error('MP3 encoder not available.');
    }

    const channels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const mp3encoder = new encoderLib.Mp3Encoder(channels, sampleRate, kbps);
    const mp3Data = [];
    const sampleBlockSize = 1152;

    if (channels === 1) {
      const samples = floatToInt16(audioBuffer.getChannelData(0));
      for (let i = 0; i < samples.length; i += sampleBlockSize) {
        const chunk = samples.subarray(i, i + sampleBlockSize);
        const mp3buf = mp3encoder.encodeBuffer(chunk);
        if (mp3buf.length > 0) mp3Data.push(mp3buf);
      }
    } else {
      const left = floatToInt16(audioBuffer.getChannelData(0));
      const right = floatToInt16(audioBuffer.getChannelData(1));
      for (let i = 0; i < left.length; i += sampleBlockSize) {
        const leftChunk = left.subarray(i, i + sampleBlockSize);
        const rightChunk = right.subarray(i, i + sampleBlockSize);
        const mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
        if (mp3buf.length > 0) mp3Data.push(mp3buf);
      }
    }

    const endBuf = mp3encoder.flush();
    if (endBuf.length > 0) mp3Data.push(endBuf);

    if (typeof Blob === 'undefined') {
      return mp3Data;
    }
    return new Blob(mp3Data, { type: 'audio/mp3' });
  }

  /**
   * Evaluates supported MediaRecorder MIME types for audio recordings.
   */
  function getAudioRecorderOptions(targetFormat, isTypeSupportedFn) {
    const checkSupport = isTypeSupportedFn || (
      typeof window !== 'undefined' &&
      window.MediaRecorder &&
      typeof MediaRecorder.isTypeSupported === 'function'
        ? (mime) => MediaRecorder.isTypeSupported(mime)
        : () => false
    );

    const mimeTypes = [
      { mime: 'audio/webm;codecs=opus', ext: 'webm' },
      { mime: 'audio/webm', ext: 'webm' },
      { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
      { mime: 'audio/mp4', ext: 'm4a' },
      { mime: 'audio/aac', ext: 'm4a' }
    ];

    let matchedMime = '';
    for (const item of mimeTypes) {
      if (checkSupport(item.mime)) {
        matchedMime = item.mime;
        break;
      }
    }
    const ext = targetFormat === 'wav' ? 'wav' : (targetFormat === 'mp3' ? 'mp3' : 'webm');
    return { mimeType: matchedMime, extension: ext, format: targetFormat };
  }

  /**
   * Evaluates supported MediaRecorder MIME types for video recordings.
   */
  function getVideoRecorderOptions(targetFormat, isTypeSupportedFn) {
    const checkSupport = isTypeSupportedFn || (
      typeof window !== 'undefined' &&
      window.MediaRecorder &&
      typeof MediaRecorder.isTypeSupported === 'function'
        ? (mime) => MediaRecorder.isTypeSupported(mime)
        : () => false
    );

    if (targetFormat === 'mp4') {
      const mp4Mimes = [
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4;codecs=avc1,opus',
        'video/mp4;codecs=avc1',
        'video/mp4;codecs=h264,aac',
        'video/mp4;codecs=h264',
        'video/mp4'
      ];
      for (const mime of mp4Mimes) {
        if (checkSupport(mime)) {
          return { mimeType: mime, extension: 'mp4', format: 'mp4' };
        }
      }
    }

    const webmMimes = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    for (const mime of webmMimes) {
      if (checkSupport(mime)) {
        return { mimeType: mime, extension: 'webm', format: 'webm' };
      }
    }

    return { mimeType: '', extension: 'webm', format: 'webm' };
  }

  /**
   * Matches a preferred device name against browser audio input devices.
   */
  function matchDevice(preferredName, audioInputs = []) {
    if (!preferredName || preferredName === 'browser' || !audioInputs.length) {
      return { deviceId: null, label: '' };
    }
    const cleanTarget = preferredName.toLowerCase().replace(/\s*\(system default\)\s*/i, '').trim();
    const matched = audioInputs.find((d) => {
      const lbl = (d.label || '').toLowerCase();
      return lbl && (lbl.includes(cleanTarget) || cleanTarget.includes(lbl));
    });
    if (matched) {
      return { deviceId: matched.deviceId, label: matched.label };
    }
    return { deviceId: null, label: '' };
  }

  /**
   * Builds audio constraints, turning off aggressive browser filtering for external studio mics.
   */
  function buildAudioConstraints(matchedDeviceId, isExternal) {
    return {
      audio: matchedDeviceId ? {
        deviceId: { exact: matchedDeviceId },
        echoCancellation: !isExternal,
        noiseSuppression: !isExternal,
        autoGainControl: !isExternal,
      } : {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    };
  }

  /**
   * Generates timestamped recording filenames matching standard session convention.
   */
  function getRecordingFilename(mode, extension, now = new Date()) {
    const prefix = mode === 'audio' ? 'Teleprompter-Audio' : 'Teleprompter-Session';
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return `${prefix}-${dateStr}.${extension}`;
  }


  // =========================================================================
  // MediaSession Coordinator Class
  // =========================================================================

  class MediaSession {
    constructor(options = {}) {
      this.options = Object.assign({
        fftSize: 256,
        targetSampleRate: 16000
      }, options);

      this.audioStream = null;
      this.videoStream = null;
      this.audioContext = null;
      this.analyser = null;
      this.analyserSource = null;
      this.captureNode = null;

      this.mediaRecorder = null;
      this.recordedChunks = [];
      this.activeRecordingOptions = null;
      this.activeRecordMode = 'video';
      this.activeAudioFormat = 'mp3';
      this.activeVideoFormat = 'mp4';

      this.activeAudioSourceName = null;
      this.vuLoopStarted = false;
      this.lastLocalLevelTime = 0;

      // Event / Callback hooks
      this.onAudioChunk = null; // (float32ArraySamples) => void
      this.onVuLevel = null;   // (levelPercent) => void
      this.onError = null;     // (err) => void
      this.onDeviceChanged = null; // (label) => void
    }

    /**
     * Lazily initialize or resume AudioContext
     */
    async ensureAudioContext() {
      if (!this.audioContext && typeof window !== 'undefined') {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          this.audioContext = new AudioCtx();
        }
      }
      if (this.audioContext && this.audioContext.state === 'suspended') {
        try {
          await this.audioContext.resume();
        } catch (_) {}
      }
      return this.audioContext;
    }

    /**
     * Initializes or switches the active browser microphone stream.
     */
    async switchAudioDevice(preferredName) {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return null;
      }

      await this.ensureAudioContext();

      // Enumerate browser audio devices
      let devices = await navigator.mediaDevices.enumerateDevices();
      let audioInputs = devices.filter((d) => d.kind === 'audioinput');

      // If devices lack labels (initial permission needed), request quick permission
      if (audioInputs.length > 0 && !audioInputs.some((d) => d.label)) {
        try {
          const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          tempStream.getTracks().forEach((t) => t.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
          audioInputs = devices.filter((d) => d.kind === 'audioinput');
        } catch (_) {}
      }

      const { deviceId, label } = matchDevice(preferredName, audioInputs);
      const isExternal = preferredName && !preferredName.toLowerCase().includes('macbook') && preferredName !== 'browser';
      const constraints = buildAudioConstraints(deviceId, isExternal);

      if (this.audioStream) {
        this.audioStream.getTracks().forEach((t) => t.stop());
      }

      this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);
      const activeTrack = this.audioStream.getAudioTracks()[0];
      const activeLabel = (activeTrack && activeTrack.label) ? activeTrack.label : (label || preferredName || 'Microphone');
      this.activeAudioSourceName = activeLabel;

      if (typeof this.onDeviceChanged === 'function') {
        this.onDeviceChanged(activeLabel);
      }

      // Reconnect analyser node
      if (this.analyserSource) {
        try { this.analyserSource.disconnect(); } catch (_) {}
      }
      if (!this.analyser && this.audioContext) {
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = this.options.fftSize;
      }
      if (this.audioContext && this.audioStream) {
        this.analyserSource = this.audioContext.createMediaStreamSource(this.audioStream);
        this.analyserSource.connect(this.analyser);
      }

      this.startVuLoop();

      // If streaming was actively running, restart node on new stream
      if (this.captureNode) {
        this.stopStreaming();
        this.startStreaming();
      }

      return activeLabel;
    }

    async initAudio(preferredName) {
      if (this.audioStream && this.audioStream.active) return;
      return await this.switchAudioDevice(preferredName);
    }

    /**
     * Camera stream lifecycle
     */
    async startCamera(videoElem) {
      this.stopCamera(videoElem);
      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (videoElem) {
        videoElem.srcObject = this.videoStream;
        videoElem.classList.remove('hidden');
      }
      return this.videoStream;
    }

    stopCamera(videoElem) {
      if (this.videoStream) {
        this.videoStream.getTracks().forEach((t) => t.stop());
        this.videoStream = null;
      }
      if (videoElem) {
        if (videoElem.srcObject) videoElem.srcObject = null;
        videoElem.classList.add('hidden');
      }
    }

    /**
     * Starts downsampled 16kHz audio streaming for real-time speech-to-text
     */
    startStreaming(chunkCallback) {
      if (this.captureNode || !this.audioContext || !this.audioStream) return;
      if (chunkCallback) this.onAudioChunk = chunkCallback;

      try {
        if (this.audioContext.state === 'suspended') {
          this.audioContext.resume().catch(() => {});
        }
        const source = this.audioContext.createMediaStreamSource(this.audioStream);
        this.captureNode = this.audioContext.createScriptProcessor(4096, 1, 1);
        const silent = this.audioContext.createGain();
        silent.gain.value = 0;
        source.connect(this.captureNode);
        this.captureNode.connect(silent);
        silent.connect(this.audioContext.destination);

        this.captureNode.onaudioprocess = (e) => {
          if (!this.captureNode) return;
          const raw = e.inputBuffer.getChannelData(0);
          const out = resampleTo16k(raw, this.audioContext.sampleRate);
          if (out.length > 0 && typeof this.onAudioChunk === 'function') {
            this.onAudioChunk(out);
          }
        };
      } catch (err) {
        if (typeof this.onError === 'function') this.onError(err);
      }
    }

    stopStreaming() {
      if (this.captureNode) {
        try { this.captureNode.disconnect(); } catch (_) {}
        this.captureNode = null;
      }
    }

    /**
     * Starts local media recording with high-fidelity native streams.
     */
    async startRecording({ mode = 'video', audioFormat = 'mp3', videoFormat = 'mp4' } = {}) {
      this.activeRecordMode = mode;
      this.activeAudioFormat = audioFormat;
      this.activeVideoFormat = videoFormat;
      this.recordedChunks = [];

      if (!this.audioStream || !this.audioStream.getAudioTracks().some((t) => t.readyState === 'live')) {
        await this.switchAudioDevice(this.activeAudioSourceName);
      }

      const tracksToRecord = [];
      if (mode === 'video' && this.videoStream) {
        tracksToRecord.push(...this.videoStream.getVideoTracks().filter((t) => t.readyState === 'live'));
      }
      if (this.audioStream) {
        tracksToRecord.push(...this.audioStream.getAudioTracks().filter((t) => t.readyState === 'live'));
      }

      if (tracksToRecord.length === 0) {
        this.mediaRecorder = null;
        throw new Error('No live tracks available to record.');
      }

      const hasVideoTrack = tracksToRecord.some((t) => t.kind === 'video');
      if (mode === 'audio' || !hasVideoTrack) {
        this.activeRecordingOptions = getAudioRecorderOptions(audioFormat);
      } else {
        this.activeRecordingOptions = getVideoRecorderOptions(videoFormat);
      }

      const streamToRecord = new MediaStream(tracksToRecord);
      const recorderOpts = this.activeRecordingOptions.mimeType ? { mimeType: this.activeRecordingOptions.mimeType } : {};
      this.mediaRecorder = new MediaRecorder(streamToRecord, recorderOpts);
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };
      this.mediaRecorder.start(1000);
      return this.mediaRecorder;
    }

    /**
     * Stops recording and resolves with the final encoded Blob and filename.
     */
    stopRecording(onProgressCallback) {
      return new Promise((resolve, reject) => {
        if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
          return resolve(null);
        }

        this.mediaRecorder.onstop = async () => {
          try {
            const recordedBlob = new Blob(this.recordedChunks, {
              type: (this.activeRecordingOptions && this.activeRecordingOptions.mimeType) || 'audio/webm'
            });

            let finalBlob = recordedBlob;
            let finalExtension = (this.activeRecordingOptions && this.activeRecordingOptions.extension) || 'webm';

            // Convert to WAV or MP3 for audio if selected
            if (this.activeRecordMode === 'audio' && (this.activeAudioFormat === 'wav' || this.activeAudioFormat === 'mp3')) {
              if (typeof onProgressCallback === 'function') {
                onProgressCallback(`Processing ${this.activeAudioFormat.toUpperCase()} audio…`);
              }

              const arrayBuffer = await recordedBlob.arrayBuffer();
              const decodeContext = new (window.AudioContext || window.webkitAudioContext)();
              const audioBuffer = await decodeContext.decodeAudioData(arrayBuffer);

              if (this.activeAudioFormat === 'wav') {
                finalBlob = audioBufferToWav(audioBuffer);
                finalExtension = 'wav';
              } else if (this.activeAudioFormat === 'mp3') {
                finalBlob = audioBufferToMp3(audioBuffer, 192);
                finalExtension = 'mp3';
              }
              try { decodeContext.close(); } catch (_) {}
            }

            const filename = getRecordingFilename(this.activeRecordMode, finalExtension);
            resolve({ blob: finalBlob, extension: finalExtension, filename: filename });
          } catch (err) {
            // Fallback: resolve with raw recorded chunks
            const fallbackExt = (this.activeRecordingOptions && this.activeRecordingOptions.extension) || 'webm';
            const fallbackBlob = new Blob(this.recordedChunks, {
              type: (this.activeRecordingOptions && this.activeRecordingOptions.mimeType) || 'audio/webm'
            });
            const filename = getRecordingFilename(this.activeRecordMode, fallbackExt);
            resolve({ blob: fallbackBlob, extension: fallbackExt, filename: filename, error: err });
          }
        };

        this.mediaRecorder.stop();
      });
    }

    /**
     * Starts continuous VU meter analysis loop.
     */
    startVuLoop() {
      if (this.vuLoopStarted) return;
      this.vuLoopStarted = true;
      const dataArray = new Uint8Array(128);

      const processLocalAudio = () => {
        if (this.analyser) {
          this.analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 2; i < 30; i++) sum += dataArray[i];
          const average = sum / 28;
          // Sensitivity scaling: 96 provides responsive feedback for studio/dynamic mics
          const levelPercent = Math.min(100, Math.round((average / 96) * 100));
          if (levelPercent > 0) {
            this.lastLocalLevelTime = Date.now();
            if (typeof this.onVuLevel === 'function') this.onVuLevel(levelPercent);
          } else if (Date.now() - this.lastLocalLevelTime > 300) {
            if (typeof this.onVuLevel === 'function') this.onVuLevel(0);
          }
        }
        if (typeof requestAnimationFrame !== 'undefined') {
          requestAnimationFrame(processLocalAudio);
        }
      };

      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(processLocalAudio);
      }
    }
  }

  return {
    // Math & Binary Encoders
    resampleTo16k,
    floatToInt16,
    audioBufferToWav,
    audioBufferToMp3,
    getAudioRecorderOptions,
    getVideoRecorderOptions,
    matchDevice,
    buildAudioConstraints,
    getRecordingFilename,
    // Coordinator
    MediaSession
  };
});
