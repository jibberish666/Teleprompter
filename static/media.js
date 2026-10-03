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
   * Slices a continuous AudioBuffer between startSeconds and endSeconds with zero generational loss.
   *
   * @param {AudioBuffer|object} audioBuffer - Source Web Audio buffer
   * @param {number} startSeconds - Cut start in seconds
   * @param {number} endSeconds - Cut end in seconds
   * @returns {AudioBuffer|object} Sliced buffer
   */
  function sliceAudioBuffer(audioBuffer, startSeconds, endSeconds) {
    if (!audioBuffer || audioBuffer.length === 0) return null;
    const sampleRate = audioBuffer.sampleRate;
    const numChannels = audioBuffer.numberOfChannels;
    const totalDuration = audioBuffer.length / sampleRate;

    const clampedStart = Math.max(0, Math.min(totalDuration, startSeconds || 0));
    const clampedEnd = Math.max(clampedStart, Math.min(totalDuration, endSeconds !== undefined ? endSeconds : totalDuration));

    const startSample = Math.max(0, Math.floor(clampedStart * sampleRate));
    const endSample = Math.min(audioBuffer.length, Math.ceil(clampedEnd * sampleRate));
    const sliceLength = Math.max(0, endSample - startSample);

    let sliced;
    if (typeof AudioBuffer !== 'undefined') {
      try {
        sliced = new AudioBuffer({
          length: Math.max(1, sliceLength),
          numberOfChannels: numChannels,
          sampleRate: sampleRate
        });
      } catch (_) {
        // Fallback for older Web Audio implementations
      }
    }

    if (!sliced) {
      // Mock / fallback AudioBuffer for Node test environment and older browsers
      const channels = [];
      for (let ch = 0; ch < numChannels; ch++) {
        channels.push(new Float32Array(sliceLength));
      }
      sliced = {
        numberOfChannels: numChannels,
        sampleRate: sampleRate,
        length: sliceLength,
        duration: sliceLength / sampleRate,
        getChannelData: (ch) => channels[ch]
      };
    }

    for (let ch = 0; ch < numChannels; ch++) {
      const srcData = audioBuffer.getChannelData(ch);
      const dstData = sliced.getChannelData(ch);
      if (sliceLength > 0) {
        dstData.set(srcData.subarray(startSample, endSample));
      }
    }

    return sliced;
  }

  /**
   * Concatenates multiple AudioBuffers into a single unified continuous AudioBuffer.
   *
   * @param {Array<AudioBuffer|object>} buffers - Array of Web Audio buffers
   * @returns {AudioBuffer|object} Concatenated buffer
   */
  function concatAudioBuffers(buffers) {
    if (!buffers || buffers.length === 0) return null;
    const validBuffers = buffers.filter((b) => b && b.length > 0);
    if (validBuffers.length === 0) return null;
    if (validBuffers.length === 1) return validBuffers[0];

    const sampleRate = validBuffers[0].sampleRate;
    const numChannels = validBuffers[0].numberOfChannels;
    const totalLength = validBuffers.reduce((acc, b) => acc + b.length, 0);

    let concatenated;
    if (typeof AudioBuffer !== 'undefined') {
      try {
        concatenated = new AudioBuffer({
          length: totalLength,
          numberOfChannels: numChannels,
          sampleRate: sampleRate
        });
      } catch (_) {}
    }

    if (!concatenated) {
      const channels = [];
      for (let ch = 0; ch < numChannels; ch++) {
        channels.push(new Float32Array(totalLength));
      }
      concatenated = {
        numberOfChannels: numChannels,
        sampleRate: sampleRate,
        length: totalLength,
        duration: totalLength / sampleRate,
        getChannelData: (ch) => channels[ch]
      };
    }

    for (let ch = 0; ch < numChannels; ch++) {
      const dstData = concatenated.getChannelData(ch);
      let offset = 0;
      for (const buf of validBuffers) {
        const srcData = buf.getChannelData(ch);
        dstData.set(srcData, offset);
        offset += buf.length;
      }
    }

    return concatenated;
  }

  /**
   * Reconciles section boundaries for take slicing.
   * If multiple sections are defined and the recorded buffer duration extends beyond Section 1,
   * unstarted sections that follow an ended section are assigned their proportional slice rather than skipped.
   *
   * @param {Array<object>} sections - Section descriptor objects
   * @param {number} totalDuration - Total audio buffer duration in seconds
   * @returns {Array<object>} Reconciled sections
   */
  function reconcileSectionBoundaries(sections = [], totalDuration = 0) {
    if (!Array.isArray(sections) || sections.length <= 1 || totalDuration <= 0) {
      return sections;
    }

    const reconciled = sections.map((s) => Object.assign({}, s));
    const sec1 = reconciled[0];

    // Enforce retakeSec floor on first section if retaken
    if (sec1 && sec1.retakeSec !== null && sec1.retakeSec !== undefined && !isNaN(Number(sec1.retakeSec))) {
      const r1 = Number(sec1.retakeSec);
      if (sec1.startSec !== null && !isNaN(Number(sec1.startSec)) && sec1.startSec < r1) {
        sec1.startSec = r1;
      }
    }

    const sec1End = (sec1.endSec !== null && sec1.endSec !== undefined && !isNaN(Number(sec1.endSec)))
      ? Number(sec1.endSec)
      : (sec1.startSec !== null && sec1.startSec !== undefined && !isNaN(Number(sec1.startSec)) ? Number(sec1.startSec) : null);

    // If recorded buffer duration extends beyond Section 1
    if (sec1End !== null && totalDuration > sec1End) {
      for (let i = 1; i < reconciled.length; i++) {
        const sec = reconciled[i];
        const prev = reconciled[i - 1];
        const prevEnd = (prev.endSec !== null && prev.endSec !== undefined && !isNaN(Number(prev.endSec)))
          ? Number(prev.endSec)
          : null;

        const isUnstarted = sec.startSec === null || sec.startSec === undefined || isNaN(Number(sec.startSec));
        if (isUnstarted && prevEnd !== null && totalDuration > prevEnd) {
          const minStart = (sec.retakeSec !== null && sec.retakeSec !== undefined && !isNaN(Number(sec.retakeSec)))
            ? Math.max(prevEnd, Number(sec.retakeSec))
            : prevEnd;

          // Count unstarted sections from i to end
          let unstartedCount = 0;
          for (let k = i; k < reconciled.length; k++) {
            const s = reconciled[k];
            if (s.startSec === null || s.startSec === undefined || isNaN(Number(s.startSec))) {
              unstartedCount++;
            }
          }
          const remainingTime = Math.max(0, totalDuration - minStart);
          const sliceDuration = unstartedCount > 0 ? (remainingTime / unstartedCount) : remainingTime;
          sec.startSec = minStart;
          if (sec.endSec === null || sec.endSec === undefined || isNaN(Number(sec.endSec))) {
            sec.endSec = Math.min(totalDuration, minStart + sliceDuration);
          }
        } else if (sec.retakeSec !== null && sec.retakeSec !== undefined && !isNaN(Number(sec.retakeSec))) {
          const rSec = Number(sec.retakeSec);
          if (sec.startSec !== null && !isNaN(Number(sec.startSec)) && sec.startSec < rSec) {
            sec.startSec = rSec;
          }
        }
      }
    }

    return reconciled;
  }

  // Persisted master-tail trim (seconds, 0–1 in 0.1 steps). Shared with export.js via localStorage.
  function readStoredMasterTrim() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem('teleprompter_master_trim');
        if (saved !== null && !isNaN(Number(saved))) {
          return Math.min(1, Math.max(0, Math.round(Number(saved) * 10) / 10));
        }
      }
    } catch (_) {}
    return 0;
  }

  /**
   * Slices an AudioBuffer into discrete section takes and a stitched master take.
   *
   * @param {AudioBuffer|object} audioBuffer - Decoded audio buffer
   * @param {Array<{id: string, title: string, startSec: number|null, endSec: number|null}>} [sections] - Section markers
   * @param {'wav'|'mp3'} [format='wav'] - Target audio encoding format
   * @param {number} [pad=0.25] - Silence padding in seconds around section bounds
   * @returns {{ takes: Array<{ filename: string, title: string, duration: number, blob: Blob|ArrayBuffer, isMaster: boolean }> }}
   */
  function processAudioTakes(audioBuffer, sections = [], format = 'wav', pad = 0.25, onProgress = null, masterTrimSec = 0) {
    if (!audioBuffer || !Array.isArray(sections) || sections.length === 0) {
      return { takes: [] };
    }

    const cleanSectionBuffers = [];
    const takes = [];
    let prevMasterEnd = null;
    let prevRawEnd = null;
    const totalDuration = audioBuffer.duration || (audioBuffer.length / audioBuffer.sampleRate) || 0;
    const effectiveSections = reconcileSectionBoundaries(sections, totalDuration);

    for (let i = 0; i < effectiveSections.length; i++) {
      const sec = effectiveSections[i];
      // Guard against unreached or unstarted sections:
      // If startSec is null, undefined, or NaN, this section was never reached or spoken.
      if (sec.startSec === null || sec.startSec === undefined || isNaN(Number(sec.startSec))) {
        continue;
      }

      const rawStart = Number(sec.startSec);
      const rawEnd = (sec.endSec !== null && sec.endSec !== undefined && !isNaN(Number(sec.endSec)))
        ? Number(sec.endSec)
        : totalDuration;

      const sStart = Math.max(0, rawStart - pad);
      const sEnd = Math.min(totalDuration, rawEnd + pad);

      if (sEnd > sStart) {
        if (typeof onProgress === 'function') {
          const pct = Math.min(94, Math.round(82 + ((i + 1) / effectiveSections.length) * 12));
          onProgress({
            phase: 'slicing',
            percent: pct,
            text: `Slicing take [${sec.title || sec.id}]…`,
            timeRemaining: 'Almost done…'
          });
        }
        const sliceBuf = sliceAudioBuffer(audioBuffer, sStart, sEnd);
        if (sliceBuf) {
          // Master only: neighbouring padded cuts overlap, which would play that audio twice.
          // Start this piece where the previous one ended when the overlap is just padding.
          let masterPiece = sliceBuf;
          if (prevMasterEnd !== null && sStart < prevMasterEnd && rawStart >= prevRawEnd - 0.05) {
            masterPiece = (prevMasterEnd < sEnd) ? sliceAudioBuffer(audioBuffer, prevMasterEnd, sEnd) : null;
          }
          if (masterPiece) cleanSectionBuffers.push(masterPiece);
          prevMasterEnd = sEnd;
          prevRawEnd = rawEnd;
          let secBlob;
          if (format === 'mp3') {
            secBlob = audioBufferToMp3(sliceBuf, 192);
          } else {
            secBlob = audioBufferToWav(sliceBuf);
          }
          takes.push({
            filename: `${sec.id}.${format}`,
            title: `Section [${sec.title}]`,
            duration: sEnd - sStart,
            blob: secBlob,
            isMaster: false
          });
        }
      }
    }

    // Concatenate clean section buffers into everything.[format]
    if (cleanSectionBuffers.length > 0) {
      if (typeof onProgress === 'function') {
        onProgress({
          phase: 'master',
          percent: 96,
          text: 'Assembling spliced master take…',
          timeRemaining: 'Almost done…'
        });
      }
      const fullBuf = concatAudioBuffers(cleanSectionBuffers);
      const fullDur = fullBuf.duration || (fullBuf.length / fullBuf.sampleRate);
      // Builds the master blob with `sec` seconds chopped off the end (0–1s, master only).
      const renderMaster = (sec) => {
        const trim = Math.min(1, Math.max(0, Number(sec) || 0));
        let buf = fullBuf;
        if (trim > 0 && fullDur - trim > 0.1) {
          const trimmedBuf = sliceAudioBuffer(fullBuf, 0, fullDur - trim);
          if (trimmedBuf) buf = trimmedBuf;
        }
        const blob = format === 'mp3' ? audioBufferToMp3(buf, 192) : audioBufferToWav(buf);
        return { blob, duration: buf.duration || (buf.length / buf.sampleRate) };
      };
      const initialTrim = Math.min(1, Math.max(0, Number(masterTrimSec) || 0));
      const rendered = renderMaster(initialTrim);
      takes.push({
        filename: `everything.${format}`,
        title: 'Spliced Master Take',
        duration: rendered.duration,
        blob: rendered.blob,
        isMaster: true,
        // Trim support: untrimmed WAV for instant preview + re-render callback for Apply.
        trimSec: initialTrim,
        fullDuration: fullDur,
        rawBlob: audioBufferToWav(fullBuf),
        retrim: renderMaster
      });
    }

    return { takes };
  }

  // =========================================================================
  // Zero-Dependency In-Browser PKZIP Archive Builder
  // =========================================================================

  // Precomputed CRC-32 lookup table (polynomial 0xEDB88320)
  const CRC32_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC32_TABLE[i] = c >>> 0;
  }

  function computeCrc32(uint8Array) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < uint8Array.length; i++) {
      crc = CRC32_TABLE[(crc ^ uint8Array[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * Encodes a list of files into a standard, cross-platform PKZIP archive Blob.
   * Uses compression method 0 (Store), which is instantaneous, zero-CPU overhead,
   * and universally supported by macOS Archive Utility, Windows Explorer, and unzip.
   *
   * @param {Array<{name: string, data: Blob|ArrayBuffer|Uint8Array|string}>} files
   * @returns {Promise<Blob|Uint8Array>} ZIP Blob in browser or Uint8Array in Node.js
   */
  async function createZipBlob(files) {
    if (!files || !files.length) {
      if (typeof Blob !== 'undefined') return new Blob([], { type: 'application/zip' });
      return new Uint8Array(0);
    }

    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : {
      encode: (str) => {
        const buf = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i) & 0xff;
        return buf;
      }
    };

    const entries = [];
    for (const f of files) {
      let rawBytes;
      if (typeof Blob !== 'undefined' && f.data instanceof Blob) {
        rawBytes = new Uint8Array(await f.data.arrayBuffer());
      } else if (f.data instanceof ArrayBuffer) {
        rawBytes = new Uint8Array(f.data);
      } else if (ArrayBuffer.isView(f.data)) {
        rawBytes = new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength);
      } else if (typeof f.data === 'string') {
        rawBytes = encoder.encode(f.data);
      } else {
        rawBytes = new Uint8Array(0);
      }

      const nameBytes = encoder.encode(f.name || 'file.bin');
      const crc = computeCrc32(rawBytes);

      entries.push({
        name: f.name || 'file.bin',
        nameBytes: nameBytes,
        dataBytes: rawBytes,
        crc: crc,
        size: rawBytes.byteLength
      });
    }

    // Calculate total buffer size
    let localHeadersSize = 0;
    let centralDirSize = 0;
    for (const e of entries) {
      localHeadersSize += 30 + e.nameBytes.length + e.size;
      centralDirSize += 46 + e.nameBytes.length;
    }
    const totalSize = localHeadersSize + centralDirSize + 22; // 22 for EOCD

    const zipBuffer = new ArrayBuffer(totalSize);
    const view = new DataView(zipBuffer);
    const byteView = new Uint8Array(zipBuffer);

    // Current date/time in MS-DOS format
    const now = new Date();
    const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
    const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);

    let offset = 0;
    const localHeaderOffsets = [];

    // Write Local File Headers + File Data
    for (const e of entries) {
      localHeaderOffsets.push(offset);

      // Signature 0x04034b50
      view.setUint32(offset, 0x04034b50, true);
      view.setUint16(offset + 4, 20, true); // Version needed: 2.0
      view.setUint16(offset + 6, 0x0800, true); // Flags: UTF-8 filename
      view.setUint16(offset + 8, 0, true); // Compression: Store (0)
      view.setUint16(offset + 10, dosTime, true);
      view.setUint16(offset + 12, dosDate, true);
      view.setUint32(offset + 14, e.crc, true);
      view.setUint32(offset + 18, e.size, true); // Compressed size
      view.setUint32(offset + 22, e.size, true); // Uncompressed size
      view.setUint16(offset + 26, e.nameBytes.length, true);
      view.setUint16(offset + 28, 0, true); // Extra field length

      offset += 30;
      byteView.set(e.nameBytes, offset);
      offset += e.nameBytes.length;

      byteView.set(e.dataBytes, offset);
      offset += e.size;
    }

    // Write Central Directory Headers
    const centralDirStartOffset = offset;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const localOffset = localHeaderOffsets[i];

      // Signature 0x02014b50
      view.setUint32(offset, 0x02014b50, true);
      view.setUint16(offset + 4, 20, true); // Version made by: 2.0
      view.setUint16(offset + 6, 20, true); // Version needed: 2.0
      view.setUint16(offset + 8, 0x0800, true); // Flags: UTF-8 filename
      view.setUint16(offset + 10, 0, true); // Compression: Store (0)
      view.setUint16(offset + 12, dosTime, true);
      view.setUint16(offset + 14, dosDate, true);
      view.setUint32(offset + 16, e.crc, true);
      view.setUint32(offset + 20, e.size, true);
      view.setUint32(offset + 24, e.size, true);
      view.setUint16(offset + 28, e.nameBytes.length, true);
      view.setUint16(offset + 30, 0, true); // Extra field len
      view.setUint16(offset + 32, 0, true); // Comment len
      view.setUint16(offset + 34, 0, true); // Disk start
      view.setUint16(offset + 36, 0, true); // Internal attributes
      view.setUint32(offset + 38, 0, true); // External attributes
      view.setUint32(offset + 42, localOffset, true); // Relative offset of local header

      offset += 46;
      byteView.set(e.nameBytes, offset);
      offset += e.nameBytes.length;
    }

    // Write End of Central Directory Record (EOCD)
    // Signature 0x06054b50
    view.setUint32(offset, 0x06054b50, true);
    view.setUint16(offset + 4, 0, true); // Disk number
    view.setUint16(offset + 6, 0, true); // Disk where central directory starts
    view.setUint16(offset + 8, entries.length, true); // Entries on this disk
    view.setUint16(offset + 10, entries.length, true); // Total entries
    view.setUint32(offset + 12, centralDirSize, true); // Size of central directory
    view.setUint32(offset + 16, centralDirStartOffset, true); // Offset of central directory
    view.setUint16(offset + 20, 0, true); // Comment length

    if (typeof Blob !== 'undefined') {
      return new Blob([zipBuffer], { type: 'application/zip' });
    }
    return byteView;
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

  /**
   * Overwrites section start/end times with times measured from the audio itself
   * (post-recording transcription). Sections missing from the map, or null, keep
   * their live-tracked boundaries. Mutates and returns the same sections array.
   *
   * @param {Array<{id: string, startSec: number|null, endSec: number|null}>} sections
   * @param {Object<string, {startSec: number, endSec: number}|null>} refined
   */
  function applyRefinedBoundaries(sections, refined) {
    if (!Array.isArray(sections) || !refined) return sections;
    for (const s of sections) {
      const r = refined[s.id];
      if (r && isFinite(Number(r.startSec)) && isFinite(Number(r.endSec)) && Number(r.endSec) > Number(r.startSec)) {
        s.startSec = Number(r.startSec);
        s.endSec = Number(r.endSec);
      }
    }
    return sections;
  }

  /**
   * Downmixes an AudioBuffer to mono and resamples it to 16 kHz signed 16-bit PCM
   * (what the server-side Whisper pass expects). Box-averages when downsampling.
   * @returns {Int16Array}
   */
  function audioBufferToPcm16k(audioBuffer) {
    const targetRate = 16000;
    const channels = audioBuffer.numberOfChannels;
    const srcRate = audioBuffer.sampleRate;
    const len = audioBuffer.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < channels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += data[i] / channels;
    }
    const ratio = srcRate / targetRate;
    const outLen = Math.floor(len / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(len, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += mono[j];
      const v = Math.max(-1, Math.min(1, sum / (end - start)));
      out[i] = v < 0 ? v * 32768 : v * 32767;
    }
    return out;
  }

  /**
   * Converts a time in seconds into an SMPTE timecode string (HH:MM:SS:FF)
   * at the specified frame rate (default: 30 fps, non-drop frame).
   *
   * @param {number} seconds - Time in seconds
   * @param {number} [fps=30] - Frame rate
   * @returns {string} HH:MM:SS:FF
   */
  function secondsToSMPTE(seconds, fps = 30) {
    const totalFrames = Math.max(0, Math.round(Number(seconds || 0) * fps));
    const ff = totalFrames % fps;
    const totalSecs = Math.floor(totalFrames / fps);
    const ss = totalSecs % 60;
    const mm = Math.floor(totalSecs / 60) % 60;
    const hh = Math.floor(totalSecs / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
  }

  /**
   * Generates a standard CMX 3600 Edit Decision List (EDL) string
   * for a clean assembly cut of the approved section takes.
   * Skips any aborted takes.
   *
   * @param {string} sourceClipName - Filename of the source video (e.g. recording-...webm)
   * @param {Array<object>} sections - Section markers with startSec, endSec, title, retakeSec
   * @param {number} [fps=30] - Target frame rate
   * @returns {string} CMX 3600 EDL formatted text
   */
  function generateEdl(sourceClipName, sections = [], fps = 30) {
    const cleanBase = (sourceClipName || 'recording').replace(/\.[^.]+$/, '');
    const lines = [
      `TITLE: ${cleanBase}`,
      'FCM: NON-DROP FRAME',
      ''
    ];

    let eventNum = 1;
    let dstTimelineSec = 0;

    for (const sec of sections) {
      if (!sec || sec.startSec === null || sec.startSec === undefined || isNaN(Number(sec.startSec)) ||
          sec.endSec === null || sec.endSec === undefined || isNaN(Number(sec.endSec))) {
        continue;
      }
      let rawStart = Number(sec.startSec);
      let rawEnd = Number(sec.endSec);
      if (sec.retakeSec !== null && sec.retakeSec !== undefined && !isNaN(Number(sec.retakeSec))) {
        rawStart = Math.max(rawStart, Number(sec.retakeSec));
      }
      if (rawEnd <= rawStart) {
        continue;
      }

      const takeDuration = rawEnd - rawStart;
      const srcIn = secondsToSMPTE(rawStart, fps);
      const srcOut = secondsToSMPTE(rawEnd, fps);
      const dstIn = secondsToSMPTE(dstTimelineSec, fps);
      dstTimelineSec += takeDuration;
      const dstOut = secondsToSMPTE(dstTimelineSec, fps);

      const evtStr = String(eventNum).padStart(3, '0');
      lines.push(`${evtStr}  AX       AA/V  C        ${srcIn} ${srcOut} ${dstIn} ${dstOut}`);
      lines.push(`* FROM CLIP NAME: ${sourceClipName}`);
      if (sec.title) {
        lines.push(`* SECTION: [${sec.title}]`);
      }
      lines.push('');
      eventNum++;
    }

    return lines.join('\r\n');
  }


  // =========================================================================
  // RecordingFinalizer (C2) — finalizeRecording(chunks, opts) → TakeSet
  // =========================================================================
  //
  // Pure async function: no closure over MediaRecorder, no browser event binding.
  // Testable in Node with a fake AudioBuffer.
  //
  // opts: { mimeType, extension, isAudioOnly, audioFormat, audioContext,
  //         sections[], sessionDurationSec, onProgress }
  // returns: { blob, extension, filename, takes[] }
  async function finalizeRecording(chunks, opts = {}) {
    const {
      mimeType = 'audio/webm',
      extension: rawExt = 'webm',
      isAudioOnly = true,
      audioFormat = 'webm',
      audioContext = null,
      sections = [],
      sessionDurationSec = 0,
      onProgress = null,
      refineBoundaries = null,
      masterTrimSec = 0,
    } = opts;

    const recordedBlob = new Blob(chunks, { type: mimeType });
    let finalBlob = recordedBlob;
    let finalExtension = rawExt;

    // ---- Audio encode / decode path (WAV or MP3) ----------------------------
    if (isAudioOnly && (audioFormat === 'wav' || audioFormat === 'mp3')) {
      if (typeof onProgress === 'function') {
        onProgress({
          phase: 'decode',
          percent: 8,
          text: `Preparing ${audioFormat.toUpperCase()} audio…`,
          timeRemaining: 'Estimating…'
        });
      }

      const arrayBuffer = await recordedBlob.arrayBuffer();
      const decodeCtx = audioContext ||
        (typeof window !== 'undefined' && new (window.AudioContext || window.webkitAudioContext)());

      if (decodeCtx && decodeCtx.state === 'suspended') {
        try { await decodeCtx.resume(); } catch (_) {}
      }

      let audioBuffer = null;
      if (decodeCtx) {
        try {
          // Safeguard against Chromium decodeAudioData hanging on corrupt/empty blobs
          const decodePromise = decodeCtx.decodeAudioData(arrayBuffer.slice(0));
          const timeoutPromise = new Promise((_, rej) =>
            setTimeout(() => rej(new Error('Audio decoding timed out')), 15000)
          );
          audioBuffer = await Promise.race([decodePromise, timeoutPromise]);
        } catch (decErr) {
          console.warn('decodeAudioData encountered error or timeout, retaining raw audio:', decErr);
        }
      }

      if (audioBuffer) {
        finalExtension = audioFormat === 'wav' ? 'wav' : 'mp3';
        const effectiveMode = isAudioOnly ? 'audio' : 'video';
        const filename = getRecordingFilename(effectiveMode, finalExtension);

        let takes = null;
        if (sections.length > 0) {
          if (typeof onProgress === 'function') {
            onProgress({
              phase: 'refining',
              percent: 14,
              text: 'Analyzing speech for clean cuts…',
              timeRemaining: 'Estimating…'
            });
          }
          // Optional: replace live-tracked boundaries with times measured from the
          // recorded audio itself. Any failure keeps the live boundaries.
          if (typeof refineBoundaries === 'function') {
            try {
              if (typeof onProgress === 'function') {
                onProgress({
                  phase: 'refining',
                  percent: 15,
                  text: 'Refining cuts with full transcription…',
                  timeRemaining: 'Estimating…'
                });
              }
              applyRefinedBoundaries(sections, await refineBoundaries(audioBuffer, sections, onProgress));
            } catch (refineErr) {
              console.warn('Boundary refinement failed, using live boundaries:', refineErr);
            }
          }
          const result = processAudioTakes(audioBuffer, sections, audioFormat, 0.25, onProgress, masterTrimSec);
          takes = (result && result.takes && result.takes.length > 0) ? result.takes : null;
        }

        if (takes && takes.length > 0) {
          const masterTake = takes.find((t) => t.isMaster) || takes[0];
          finalBlob = masterTake.blob;
        } else {
          // Fallback: encode master take from full audio buffer
          if (audioFormat === 'wav') {
            finalBlob = audioBufferToWav(audioBuffer);
          } else if (audioFormat === 'mp3') {
            finalBlob = audioBufferToMp3(audioBuffer, 192);
          }
          takes = [{
            filename,
            title: 'Master Session Audio',
            duration: audioBuffer.duration || (audioBuffer.length / audioBuffer.sampleRate),
            blob: finalBlob,
            isMaster: true,
          }];
        }

        return { blob: finalBlob, extension: finalExtension, filename, takes };
      }
    }

    // ---- Fallback: video, failed decode, or raw format ----------------------
    // For video mode, surface sectionMarkers as metadata (C6 preparation).
    const effectiveMode = isAudioOnly ? 'audio' : 'video';
    const filename = getRecordingFilename(effectiveMode, finalExtension);
    const sectionMarkers = sections.length > 0
      ? sections.map((s) => ({ id: s.id, title: s.title, startSec: s.startSec, endSec: s.endSec, retakeSec: s.retakeSec }))
      : [];

    const takes = [{
      filename,
      title: effectiveMode === 'video' ? 'Master Session Video' : 'Master Session Audio',
      duration: sessionDurationSec,
      blob: finalBlob,
      isMaster: true,
      sectionMarkers,
    }];

    if (effectiveMode === 'video' && sections.length > 0) {
      const edlContent = generateEdl(filename, sections, 30);
      const edlBlob = new Blob([edlContent], { type: 'text/plain;charset=utf-8' });
      const edlFilename = filename.replace(/\.[^.]+$/, '.edl');

      let cleanDur = 0;
      for (const s of sections) {
        if (s && s.startSec !== null && s.endSec !== null && !isNaN(Number(s.startSec)) && !isNaN(Number(s.endSec))) {
          const st = (s.retakeSec !== null && !isNaN(Number(s.retakeSec)))
            ? Math.max(Number(s.startSec), Number(s.retakeSec))
            : Number(s.startSec);
          if (Number(s.endSec) > st) cleanDur += (Number(s.endSec) - st);
        }
      }

      takes.push({
        filename: edlFilename,
        title: 'DaVinci Resolve EDL (Clean Assembly)',
        duration: cleanDur > 0 ? cleanDur : sessionDurationSec,
        blob: edlBlob,
        isMaster: false,
        isEdl: true,
      });
    }

    return {
      blob: finalBlob,
      extension: finalExtension,
      filename,
      sectionMarkers,
      takes,
    };
  }


  // =========================================================================
  // Media Formats & Presets
  // =========================================================================

  const VIDEO_FORMATS = [
    { id: 'mp4', label: 'MP4 (.mp4)', desc: 'Universal MP4 video format (H.264/AAC)' },
    { id: 'webm', label: 'WebM (.webm)', desc: 'High-efficiency WebM video format (VP9/Opus)' },
  ];

  const AUDIO_FORMATS = [
    { id: 'wav', label: 'WAV (.wav)', desc: 'Lossless 16-bit PCM WAV — recommended for multi-section recordings (studio quality, uncompressed)' },
    { id: 'mp3', label: 'MP3 (.mp3)', desc: 'Compressed MP3 audio (192 kbps) — may cause section splitting issues on slower machines' },
    { id: 'webm', label: 'WebM (.webm)', desc: 'WebM Opus compressed audio' },
  ];

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
      this.activeRecordMode = options.activeRecordMode || 'video';
      this.activeAudioFormat = options.activeAudioFormat || 'wav';
      this.activeVideoFormat = options.activeVideoFormat || 'mp4';

      this.activeAudioSource = options.activeAudioSource || 'browser';
      this.activeAudioSourceName = options.activeAudioSourceName || null;
      this.availableAudioDevices = [];
      this.configStore = options.configStore || null;
      this.ui = {};
      this.callbacks = {};

      this.vuLoopStarted = false;
      this.lastLocalLevelTime = 0;

      // Event / Callback hooks
      this.onAudioChunk = null; // (float32ArraySamples) => void
      this.onVuLevel = null;   // (levelPercent) => void
      this.onError = null;     // (err) => void
      this.onDeviceChanged = null; // (label) => void
    }

    /**
     * Binds UI controls (audio source dropdowns, record mode/format options) and attaches event handlers.
     */
    bindUI(elements = {}, callbacks = {}) {
      this.ui = elements;
      this.callbacks = callbacks;

      const { optAudioSource, btnRefreshAudioDevices, optRecordMode, optRecordFormat } = elements;

      if (optAudioSource) {
        optAudioSource.addEventListener('change', async (e) => {
          const devId = e.target.value;
          this.activeAudioSource = devId;
          try {
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem('teleprompter_audio_device', devId);
            }
          } catch (_) {}

          const matchedDev = this.availableAudioDevices.find((d) => String(d.id) === String(devId));
          const targetName = matchedDev ? (matchedDev.raw_name || matchedDev.name) : null;
          if (targetName) {
            this.activeAudioSourceName = targetName;
            try {
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem('teleprompter_audio_device_name', targetName);
              }
            } catch (_) {}
            if (this.configStore) {
              this.configStore.update('audio', {
                source_type: devId === 'browser' ? 'browser' : 'hardware',
                device_id: devId === 'browser' ? null : String(devId),
                device_name: targetName
              });
            }
          }

          this.updateAudioSourceUI(devId);

          if (typeof callbacks.onDeviceSelect === 'function') {
            await callbacks.onDeviceSelect(devId, targetName);
          }
        });
      }

      if (btnRefreshAudioDevices) {
        btnRefreshAudioDevices.addEventListener('click', async () => {
          btnRefreshAudioDevices.classList.add('opacity-50');
          if (typeof callbacks.onRefreshDevices === 'function') {
            await callbacks.onRefreshDevices();
          }
          setTimeout(() => btnRefreshAudioDevices.classList.remove('opacity-50'), 400);
        });
      }

      if (optRecordMode) {
        optRecordMode.addEventListener('change', () => {
          this.updateFormatUI();
        });
      }

      if (optRecordFormat) {
        optRecordFormat.addEventListener('change', (e) => {
          const mode = (optRecordMode && optRecordMode.value) ? optRecordMode.value : this.activeRecordMode;
          if (mode === 'video') {
            this.activeVideoFormat = e.target.value;
            try {
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem('teleprompter_video_format', this.activeVideoFormat);
              }
            } catch (_) {}
          } else {
            this.activeAudioFormat = e.target.value;
            try {
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem('teleprompter_audio_format', this.activeAudioFormat);
              }
            } catch (_) {}
          }
          if (this.configStore) {
            this.configStore.update('recording', {
              mode: this.activeRecordMode,
              video_format: this.activeVideoFormat,
              audio_format: this.activeAudioFormat
            });
          }
          const formats = mode === 'video' ? VIDEO_FORMATS : AUDIO_FORMATS;
          const chosen = formats.find((f) => f.id === e.target.value);
          if (this.ui.formatDesc && chosen) {
            this.ui.formatDesc.textContent = chosen.desc;
          }
          // Show/hide MP3 splitting warning
          const existingWarn = this.ui.formatSelect && this.ui.formatSelect.parentNode
            ? this.ui.formatSelect.parentNode.querySelector('.mp3-split-warning')
            : null;
          if (mode === 'audio' && e.target.value === 'mp3') {
            if (!existingWarn && this.ui.formatSelect && this.ui.formatSelect.parentNode) {
              const warn = document.createElement('p');
              warn.className = 'mp3-split-warning text-[10px] text-amber-400 leading-snug mt-1 flex items-start gap-1';
              warn.innerHTML = '<svg class="w-3 h-3 shrink-0 mt-px text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg><span>MP3 encoding can take 1–5 seconds per section on slower machines, which may cause section take splitting to fail. WAV is recommended for multi-section recordings.</span>';
              this.ui.formatSelect.parentNode.appendChild(warn);
            }
          } else {
            if (existingWarn) existingWarn.remove();
          }
          if (typeof callbacks.onFormatChange === 'function') {
            callbacks.onFormatChange(this.activeRecordMode, this.activeVideoFormat, this.activeAudioFormat);
          }
        });
      }

      if (optRecordMode && this.activeRecordMode) {
        optRecordMode.value = this.activeRecordMode;
      }
      this.updateFormatUI();
      this.updateAudioSourceUI(this.activeAudioSource);
    }

    /**
     * Updates device dropdown and badge/description displays.
     */
    updateAudioSourceUI(deviceId, devicesList) {
      if (devicesList && devicesList.length) {
        this.availableAudioDevices = devicesList;
        if (this.ui.optAudioSource && typeof document !== 'undefined') {
          this.ui.optAudioSource.innerHTML = '';
          devicesList.forEach((d) => {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.name;
            if (d.raw_name) opt.dataset.rawName = d.raw_name;
            if (String(d.id) === String(deviceId)) opt.selected = true;
            this.ui.optAudioSource.appendChild(opt);
          });
        }
      }

      if (deviceId !== undefined && deviceId !== null) {
        this.activeAudioSource = String(deviceId);
      }

      if (this.ui.optAudioSource && this.activeAudioSource) {
        this.ui.optAudioSource.value = this.activeAudioSource;
      }

      const matchedDev = this.availableAudioDevices.find((d) => String(d.id) === String(this.activeAudioSource));
      if (matchedDev && (matchedDev.raw_name || matchedDev.name)) {
        this.activeAudioSourceName = matchedDev.raw_name || matchedDev.name;
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('teleprompter_audio_device_name', this.activeAudioSourceName);
          }
        } catch (_) {}
      }

      const isBrowser = this.activeAudioSource === 'browser';
      if (this.ui.audioSourceBadge) {
        const devName = matchedDev ? (matchedDev.raw_name || matchedDev.name).replace(/\s*\(System Default\)\s*/i, '') : '';
        this.ui.audioSourceBadge.textContent = isBrowser ? 'Browser Mic' : (devName || 'Hardware Mic');
        this.ui.audioSourceBadge.className = 'text-[10px] px-1.5 py-0.5 rounded font-mono border ' +
          (isBrowser ? 'bg-green-950 text-green-300 border-green-700/50' : 'bg-indigo-950 text-indigo-300 border-indigo-700/50');
      }

      if (this.ui.audioSourceDesc) {
        const devName = matchedDev ? (matchedDev.raw_name || matchedDev.name).replace(/\s*\(System Default\)\s*/i, '') : 'selected mic';
        this.ui.audioSourceDesc.textContent = isBrowser
          ? 'Streams directly from your active browser tab mic (matches VU meter).'
          : `Backend captures directly from ${devName} for Whisper. Browser records & monitors ${devName}.`;
      }

      if (this.ui.vuSource) {
        const devName = matchedDev ? (matchedDev.raw_name || matchedDev.name).replace(/\s*\(System Default\)\s*/i, '') : (isBrowser ? 'Browser' : 'Mic');
        this.ui.vuSource.textContent = devName;
      }
    }

    /**
     * Updates record mode and audio/video format selectors and UI descriptions.
     */
    updateFormatUI() {
      const mode = (this.ui.optRecordMode && this.ui.optRecordMode.value) ? this.ui.optRecordMode.value : this.activeRecordMode;
      this.activeRecordMode = mode;

      if (this.configStore) {
        this.configStore.update('recording', {
          mode: this.activeRecordMode,
          video_format: this.activeVideoFormat,
          audio_format: this.activeAudioFormat
        });
      }
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('teleprompter_record_mode', mode);
        }
      } catch (_) {}

      if (mode === 'off') {
        if (this.ui.recordingFormatGroup) {
          this.ui.recordingFormatGroup.classList.add('hidden');
        }
      } else {
        if (this.ui.recordingFormatGroup) {
          this.ui.recordingFormatGroup.classList.remove('hidden');
        }
        if (this.ui.optRecordFormat && typeof document !== 'undefined') {
          this.ui.optRecordFormat.innerHTML = '';
          const formats = mode === 'video' ? VIDEO_FORMATS : AUDIO_FORMATS;
          const currentSelected = mode === 'video' ? this.activeVideoFormat : this.activeAudioFormat;
          formats.forEach((f) => {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.textContent = f.label;
            if (f.id === currentSelected) opt.selected = true;
            this.ui.optRecordFormat.appendChild(opt);
          });
          const chosen = formats.find((f) => f.id === this.ui.optRecordFormat.value) || formats[0];
          if (this.ui.formatDesc) {
            this.ui.formatDesc.textContent = chosen ? chosen.desc : '';
          }
        }
      }

      if (typeof this.callbacks.onFormatChange === 'function') {
        this.callbacks.onFormatChange(this.activeRecordMode, this.activeVideoFormat, this.activeAudioFormat);
      }
    }

    /**
     * Helper to enable/disable record mode & format dropdowns during recording.
     */
    setControlsDisabled(disabled) {
      if (this.ui.optRecordMode) this.ui.optRecordMode.disabled = disabled;
      if (this.ui.optRecordFormat) this.ui.optRecordFormat.disabled = disabled;
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
        if (typeof navigator !== 'undefined' && navigator.userActivation && !navigator.userActivation.hasBeenActive) {
          return this.audioContext;
        }
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

      // Guard: do not tear down live tracks if already active and matching, or if actively recording
      if (this.audioStream && this.audioStream.active &&
          this.audioStream.getAudioTracks().some((t) => t.readyState === 'live') &&
          this.activeAudioSourceName && preferredName &&
          (this.activeAudioSourceName === label || this.activeAudioSourceName.toLowerCase().includes(preferredName.toLowerCase()))) {
        return this.activeAudioSourceName;
      }

      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        console.warn('Ignoring audio device switch while recording is active');
        return this.activeAudioSourceName;
      }

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
    async startRecording({ mode = this.activeRecordMode, audioFormat = this.activeAudioFormat, videoFormat = this.activeVideoFormat } = {}) {
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
      this.hasRecordedVideoTrack = hasVideoTrack;
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
      this.mediaRecorder.onerror = (e) => {
        console.error('MediaRecorder error:', e);
        if (typeof this.onError === 'function') this.onError(e.error || e);
      };
      this.mediaRecorder.start(1000);
      return this.mediaRecorder;
    }

    /**
     * Stops recording and resolves with the final encoded Blob, filename, and section takes.
     *
     * @param {object|Function} [optionsOrCb] - Configuration options or legacy progress callback
     * @param {Array<{id: string, title: string, startSec: number|null, endSec: number|null}>} [optionsOrCb.sections] - Script section markers for take slicing
     * @param {number} [optionsOrCb.sessionDurationSec] - Total session duration in seconds
     * @param {Function} [optionsOrCb.onProgress] - Callback for encoding/slicing status updates
     * @returns {Promise<{blob: Blob, extension: string, filename: string, takes: Array<object>}|null>}
     */
    stopRecording(optionsOrCb) {
      let sections = [];
      let sessionDurationSec = 0;
      let onProgress = null;
      let refineBoundaries = null;

      if (typeof optionsOrCb === 'function') {
        onProgress = optionsOrCb;
      } else if (optionsOrCb && typeof optionsOrCb === 'object') {
        sections = Array.isArray(optionsOrCb.sections) ? optionsOrCb.sections : [];
        sessionDurationSec = Number(optionsOrCb.sessionDurationSec) || 0;
        onProgress = optionsOrCb.onProgress || optionsOrCb.onProgressCallback || null;
        refineBoundaries = typeof optionsOrCb.refineBoundaries === 'function' ? optionsOrCb.refineBoundaries : null;
      }

      return new Promise((resolve, reject) => {
        if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
          return resolve(null);
        }

        let safetyTimer = null;

        // onstop is now a thin adapter — all encode/slice logic lives in finalizeRecording() (C2)
        this.mediaRecorder.onstop = async () => {
          if (safetyTimer) {
            clearTimeout(safetyTimer);
            safetyTimer = null;
          }
          try {
            const result = await finalizeRecording(this.recordedChunks, {
              mimeType: (this.activeRecordingOptions && this.activeRecordingOptions.mimeType) || 'audio/webm',
              extension: (this.activeRecordingOptions && this.activeRecordingOptions.extension) || 'webm',
              isAudioOnly: this.activeRecordMode === 'audio' || !this.hasRecordedVideoTrack,
              audioFormat: this.activeAudioFormat,
              audioContext: this.audioContext,
              sections,
              sessionDurationSec,
              onProgress,
              refineBoundaries,
              masterTrimSec: readStoredMasterTrim(),
            });
            resolve(result);
          } catch (err) {
            console.warn('finalizeRecording threw, resolving null:', err);
            resolve(null);
          }
        };

        safetyTimer = setTimeout(() => {
          console.warn('[MEDIA] mediaRecorder.onstop failed to fire within safety threshold; invoking fallback.');
          if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            try { this.mediaRecorder.stop(); } catch (_) {}
          }
          const isAudioOnly = this.activeRecordMode === 'audio' || !this.hasRecordedVideoTrack;
          const rawMime = (this.activeRecordingOptions && this.activeRecordingOptions.mimeType) || 'audio/webm';
          const fallbackExt = rawMime.includes('mp4') ? 'mp4' : (rawMime.includes('ogg') ? 'ogg' : 'webm');
          const fallbackBlob = new Blob(this.recordedChunks, { type: rawMime });
          const effectiveMode = isAudioOnly ? 'audio' : 'video';
          const filename = getRecordingFilename(effectiveMode, fallbackExt);
          resolve({
            blob: fallbackBlob,
            extension: fallbackExt,
            filename: filename,
            takes: [{ filename, title: effectiveMode === 'video' ? 'Master Session Video' : 'Master Session Audio', duration: sessionDurationSec, blob: fallbackBlob, isMaster: true }]
          });
        }, 15000);

        try {
          if (this.mediaRecorder.state === 'recording' && typeof this.mediaRecorder.requestData === 'function') {
            this.mediaRecorder.requestData();
          }
          this.mediaRecorder.stop();
        } catch (stopErr) {
          if (safetyTimer) {
            clearTimeout(safetyTimer);
            safetyTimer = null;
          }
          console.warn('Error calling mediaRecorder.stop():', stopErr);
          resolve(null);
        }
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
    // Format Presets & Options
    VIDEO_FORMATS,
    AUDIO_FORMATS,
    // Math & Binary Encoders
    resampleTo16k,
    floatToInt16,
    audioBufferToWav,
    audioBufferToMp3,
    sliceAudioBuffer,
    concatAudioBuffers,
    processAudioTakes,
    reconcileSectionBoundaries,
    applyRefinedBoundaries,
    audioBufferToPcm16k,
    computeCrc32,
    createZipBlob,
    secondsToSMPTE,
    generateEdl,
    getAudioRecorderOptions,
    getVideoRecorderOptions,
    matchDevice,
    buildAudioConstraints,
    getRecordingFilename,
    // RecordingFinalizer (C2)
    finalizeRecording,
    // Coordinator
    MediaSession
  };
});
