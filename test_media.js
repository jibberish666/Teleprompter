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

describe('TeleprompterMedia - Audio Buffer Slicing & Concatenation', () => {
  function createMockBuffer(seconds, sampleRate = 1000) {
    const length = Math.round(seconds * sampleRate);
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      data[i] = i / length;
    }
    return {
      numberOfChannels: 1,
      sampleRate: sampleRate,
      length: length,
      duration: seconds,
      getChannelData: () => data
    };
  }

  test('slices AudioBuffer with precise sample offsets', () => {
    const original = createMockBuffer(10, 1000); // 10,000 samples
    const sliced = Media.sliceAudioBuffer(original, 2.0, 5.5);

    assert.equal(sliced.sampleRate, 1000);
    assert.equal(sliced.length, 3500, '3.5 seconds at 1000Hz must equal 3500 samples');

    const origData = original.getChannelData(0);
    const sliceData = sliced.getChannelData(0);
    assert.equal(sliceData[0], origData[2000], 'First sample must match offset 2000');
    assert.equal(sliceData[sliceData.length - 1], origData[5499], 'Last sample must match offset 5499');
  });

  test('clamps out-of-range slicing boundaries gracefully', () => {
    const original = createMockBuffer(5, 1000);
    const sliced = Media.sliceAudioBuffer(original, -2.0, 10.0);
    assert.equal(sliced.length, 5000, 'Should clamp to entire duration');
  });

  test('concatenates multiple discrete AudioBuffers sequentially', () => {
    const buf1 = createMockBuffer(1.0, 1000); // 1000 samples
    const buf2 = createMockBuffer(2.0, 1000); // 2000 samples
    const buf3 = createMockBuffer(0.5, 1000); // 500 samples

    const combined = Media.concatAudioBuffers([buf1, buf2, buf3]);
    assert.equal(combined.length, 3500, 'Combined buffer length must equal 3500');

    const cData = combined.getChannelData(0);
    assert.equal(cData[0], buf1.getChannelData(0)[0]);
    assert.equal(cData[1000], buf2.getChannelData(0)[0]);
    assert.equal(cData[3000], buf3.getChannelData(0)[0]);
  });
});

describe('TeleprompterMedia - In-Browser PKZIP Archive Builder', () => {
  test('computes standard IEEE 802.3 CRC32 checksums', () => {
    const textEncoder = new TextEncoder();
    const data = textEncoder.encode('123456789');
    const crc = Media.computeCrc32(data);
    // Standard test vector: CRC32("123456789") == 0xCBF43926 (3421780262)
    assert.equal(crc, 0xCBF43926);
  });

  test('builds valid PKZIP archive binary structure with multiple files', async () => {
    const files = [
      { name: '1.wav', data: new Uint8Array([82, 73, 70, 70]) },
      { name: '2.wav', data: new Uint8Array([87, 65, 86, 69]) },
      { name: 'everything.wav', data: new Uint8Array([1, 2, 3, 4, 5, 6]) }
    ];

    const zipResult = await Media.createZipBlob(files);
    assert.ok(zipResult instanceof Uint8Array || (typeof Blob !== 'undefined' && zipResult instanceof Blob));

    const zipBytes = zipResult instanceof Uint8Array ? zipResult : new Uint8Array(await zipResult.arrayBuffer());
    assert.ok(zipBytes.byteLength > 100, 'ZIP archive must be non-empty');

    const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);

    // Verify Local File Header signature (0x04034b50) at offset 0
    assert.equal(view.getUint32(0, true), 0x04034b50, 'Must start with PK\\x03\\x04 signature');

    // Verify End of Central Directory signature (0x06054b50) near end
    const eocdSignature = 0x06054b50;
    let foundEOCD = false;
    for (let i = zipBytes.byteLength - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === eocdSignature) {
        foundEOCD = true;
        const totalEntries = view.getUint16(i + 10, true);
        assert.equal(totalEntries, 3, 'Must record 3 total files in directory');
        break;
      }
    }
    assert.ok(foundEOCD, 'EOCD signature must be present in archive');
  });
});

describe('TeleprompterMedia - Section Take Slicing & Master Splicing', () => {
  function createMockBuffer(seconds, sampleRate = 1000) {
    const length = Math.round(seconds * sampleRate);
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      data[i] = i / length;
    }
    return {
      numberOfChannels: 1,
      sampleRate: sampleRate,
      length: length,
      duration: seconds,
      getChannelData: () => data
    };
  }

  test('slices discrete section takes and produces stitched master take with WAV format', () => {
    const original = createMockBuffer(10, 1000); // 10 second buffer
    const sections = [
      { id: '1', title: 'Introduction', startSec: 1.0, endSec: 3.0 },
      { id: '2', title: 'Specifications', startSec: 4.0, endSec: 7.0 }
    ];

    const { takes } = Media.processAudioTakes(original, sections, 'wav', 0.25);
    assert.equal(takes.length, 3, 'Must produce 2 section takes + 1 stitched master take');

    const sec1 = takes.find((t) => t.filename === '1.wav');
    assert.ok(sec1, 'Take 1.wav must exist');
    assert.equal(sec1.isMaster, false);
    assert.equal(sec1.title, 'Section [Introduction]');
    // 1.0 - 0.25 to 3.0 + 0.25 = 2.5s duration
    assert.equal(sec1.duration, 2.5);
    assert.ok(sec1.blob, 'Take must have blob/buffer data');

    const sec2 = takes.find((t) => t.filename === '2.wav');
    assert.ok(sec2, 'Take 2.wav must exist');
    assert.equal(sec2.isMaster, false);
    assert.equal(sec2.title, 'Section [Specifications]');
    // 4.0 - 0.25 to 7.0 + 0.25 = 3.5s duration
    assert.equal(sec2.duration, 3.5);

    const master = takes.find((t) => t.filename === 'everything.wav');
    assert.ok(master, 'Master take must exist');
    assert.equal(master.isMaster, true);
    assert.equal(master.title, 'Spliced Master Take');
    // Stitched duration = 2.5 + 3.5 = 6.0s
    assert.equal(master.duration, 6.0);
    assert.ok(master.blob, 'Master take must have blob/buffer data');
  });

  test('returns empty takes when no sections provided or buffer is missing', () => {
    const original = createMockBuffer(5, 1000);
    assert.deepEqual(Media.processAudioTakes(original, [], 'wav').takes, []);
    assert.deepEqual(Media.processAudioTakes(null, [{ id: '1', title: 'Test' }], 'wav').takes, []);
  });

  test('clamps out-of-range section boundaries safely to buffer duration', () => {
    const original = createMockBuffer(4, 1000);
    const sections = [
      { id: '1', title: 'Out of bounds', startSec: -2.0, endSec: 10.0 }
    ];

    const { takes } = Media.processAudioTakes(original, sections, 'wav', 0.25);
    assert.equal(takes.length, 2); // 1 section take + 1 stitched take
    const sec1 = takes[0];
    assert.equal(sec1.duration, 4.0, 'Clamped duration must equal full buffer duration');
  });

  test('omits unreached sections with null timestamps and prevents ghost duplicate takes', () => {
    const original = createMockBuffer(10, 1000);
    const sections = [
      { id: '1', title: 'Reached Section', startSec: 0.0, endSec: 4.0 },
      { id: '2', title: 'Unreached Section 2', startSec: null, endSec: null },
      { id: '3', title: 'Unreached Section 3', startSec: null, endSec: null }
    ];

    const { takes } = Media.processAudioTakes(original, sections, 'wav', 0.25);
    assert.equal(takes.length, 2, 'Must only include reached section take and stitched master take');

    const sec1 = takes.find((t) => t.filename === '1.wav');
    assert.ok(sec1, 'Take 1.wav must exist');
    assert.equal(sec1.title, 'Section [Reached Section]');
    // 0.0 to 4.0 + 0.25 = 4.25s
    assert.equal(sec1.duration, 4.25);

    const sec2 = takes.find((t) => t.filename === '2.wav');
    assert.equal(sec2, undefined, 'Unreached Section 2 must not produce a take');

    const sec3 = takes.find((t) => t.filename === '3.wav');
    assert.equal(sec3, undefined, 'Unreached Section 3 must not produce a take');

    const master = takes.find((t) => t.filename === 'everything.wav');
    assert.ok(master, 'Master take must exist');
    assert.equal(master.duration, 4.25, 'Master take must only concatenate reached sections');
  });
});

