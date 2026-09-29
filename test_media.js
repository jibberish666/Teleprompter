/**
 * Unit tests for TeleprompterMedia module using Node.js built-in test runner.
 * Run with: node --test test_media.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Media = require('./static/media.js');

describe('TeleprompterMedia - Resampling Pipeline (16 kHz)', () => {
  test('downsamples 48 kHz buffer to 16 kHz with exact 3:1 ratio', () => {
    const inputSampleRate = 48000;
    const inputLength = 4800; // 0.1 seconds
    const input = new Float32Array(inputLength);
    // Fill with a simple ramp
    for (let i = 0; i < inputLength; i++) {
      input[i] = i / inputLength;
    }

    const output = Media.resampleTo16k(input, inputSampleRate);
    assert.equal(output.length, 1600, '48000Hz to 16000Hz downsampling ratio must be exactly 3:1');
    assert.ok(output[0] >= 0 && output[output.length - 1] <= 1.0, 'Values must remain in bounded range');
  });

  test('downsamples 44.1 kHz buffer to 16 kHz accurately', () => {
    const inputSampleRate = 44100;
    const inputLength = 4410;
    const input = new Float32Array(inputLength);
    for (let i = 0; i < inputLength; i++) {
      input[i] = Math.sin((2 * Math.PI * 440 * i) / inputSampleRate);
    }

    const output = Media.resampleTo16k(input, inputSampleRate);
    const expectedLen = Math.floor(inputLength / (44100 / 16000));
    assert.equal(output.length, expectedLen);
  });

  test('returns identity copy when input sample rate is already 16 kHz', () => {
    const input = new Float32Array([0.1, 0.5, -0.3, 0.8]);
    const output = Media.resampleTo16k(input, 16000);
    assert.equal(output.length, input.length);
    for (let i = 0; i < input.length; i++) {
      assert.ok(Math.abs(output[i] - input[i]) < 1e-5, `Value at ${i} should match`);
    }
  });

  test('handles empty or zero-length input gracefully', () => {
    const output = Media.resampleTo16k(new Float32Array(0), 48000);
    assert.equal(output.length, 0);
  });
});

describe('TeleprompterMedia - Float to Int16 Conversion', () => {
  test('clamps and maps [-1.0, 1.0] to 16-bit signed integer range', () => {
    const input = new Float32Array([-1.5, -1.0, 0.0, 1.0, 2.0]);
    const int16 = Media.floatToInt16(input);

    assert.equal(int16[0], -32768, 'Values below -1.0 must clamp to -32768');
    assert.equal(int16[1], -32768, '-1.0 must map to -32768');
    assert.equal(int16[2], 0, '0.0 must map to 0');
    assert.equal(int16[3], 32767, '1.0 must map to 32767');
    assert.equal(int16[4], 32767, 'Values above 1.0 must clamp to 32767');
  });
});

describe('TeleprompterMedia - RIFF/WAV Binary Header Generation', () => {
  test('constructs valid RIFF WAVE header and PCM byte structure', () => {
    // Synthetic AudioBuffer mock
    const sampleRate = 44100;
    const length = 1000;
    const mockChannelData = new Float32Array(length).fill(0.25);
    const mockAudioBuffer = {
      numberOfChannels: 1,
      sampleRate: sampleRate,
      length: length,
      getChannelData: () => mockChannelData
    };

    const arrayBuffer = Media.audioBufferToWav(mockAudioBuffer, true);
    assert.ok(arrayBuffer instanceof ArrayBuffer);

    const view = new DataView(arrayBuffer);
    const readString = (offset, len) => {
      let str = '';
      for (let i = 0; i < len; i++) str += String.fromCharCode(view.getUint8(offset + i));
      return str;
    };

    // Header validation
    assert.equal(readString(0, 4), 'RIFF');
    assert.equal(readString(8, 4), 'WAVE');
    assert.equal(readString(12, 4), 'fmt ');
    assert.equal(view.getUint32(16, true), 16, 'Subchunk1Size must be 16 for PCM');
    assert.equal(view.getUint16(20, true), 1, 'AudioFormat must be 1 (PCM)');
    assert.equal(view.getUint16(22, true), 1, 'NumChannels must be 1');
    assert.equal(view.getUint32(24, true), sampleRate, 'SampleRate must match');
    assert.equal(view.getUint16(34, true), 16, 'BitsPerSample must be 16');
    assert.equal(readString(36, 4), 'data');
    assert.equal(view.getUint32(40, true), length * 2, 'Data size must be length * bytesPerSample');

    // Total file size: 44 bytes header + dataSize
    assert.equal(arrayBuffer.byteLength, 44 + (length * 2));
  });
});

describe('TeleprompterMedia - Device Matching & Audio Constraints', () => {
  test('fuzzy matches device label with preferred target name', () => {
    const inputs = [
      { deviceId: 'default', label: 'Default - MacBook Pro Microphone' },
      { deviceId: 'usb-mic-123', label: 'Rode PodMic USB' }
    ];

    const match = Media.matchDevice('Rode PodMic', inputs);
    assert.equal(match.deviceId, 'usb-mic-123');
    assert.equal(match.label, 'Rode PodMic USB');
  });

  test('turns off aggressive browser DSP for external studio microphones', () => {
    const constraints = Media.buildAudioConstraints('usb-mic-123', true);
    assert.equal(constraints.audio.deviceId.exact, 'usb-mic-123');
    assert.equal(constraints.audio.echoCancellation, false, 'External mic should not have echo cancellation');
    assert.equal(constraints.audio.noiseSuppression, false, 'External mic should not have noise suppression');
    assert.equal(constraints.audio.autoGainControl, false, 'External mic should not have AGC');
  });

  test('keeps echo cancellation enabled for built-in laptop mic', () => {
    const constraints = Media.buildAudioConstraints('builtin-mic', false);
    assert.equal(constraints.audio.echoCancellation, true);
    assert.equal(constraints.audio.noiseSuppression, true);
    assert.equal(constraints.audio.autoGainControl, true);
  });
});

describe('TeleprompterMedia - Recording Options & MIME Resolution', () => {
  test('resolves preferred MIME type when supported', () => {
    const mockSupport = (mime) => mime === 'audio/webm;codecs=opus';
    const opts = Media.getAudioRecorderOptions('webm', mockSupport);
    assert.equal(opts.mimeType, 'audio/webm;codecs=opus');
    assert.equal(opts.extension, 'webm');
  });

  test('resolves MP4 video MIME types in precedence order', () => {
    const mockSupport = (mime) => mime === 'video/mp4;codecs=avc1';
    const opts = Media.getVideoRecorderOptions('mp4', mockSupport);
    assert.equal(opts.mimeType, 'video/mp4;codecs=avc1');
    assert.equal(opts.extension, 'mp4');
  });
});

describe('TeleprompterMedia - Timestamped Filename Generation', () => {
  test('generates ISO-formatted session filenames', () => {
    const fixedDate = new Date('2026-08-15T14:30:45Z');
    const audioName = Media.getRecordingFilename('audio', 'wav', fixedDate);
    const videoName = Media.getRecordingFilename('video', 'mp4', fixedDate);

    assert.match(audioName, /^Teleprompter-Audio-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.wav$/);
    assert.match(videoName, /^Teleprompter-Session-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mp4$/);
  });
});
