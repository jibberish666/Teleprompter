/**
 * Unit tests for TeleprompterMedia module using Node.js built-in test runner.
 * Run with: node --test test_media.js
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Load embedded lamejs into global scope for Node test runner
eval(fs.readFileSync(path.join(__dirname, 'static/lame.min.js'), 'utf8'));
global.lamejs = lamejs;

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

  test('processAudioTakes exports 1.mp3, 2.mp3, and everything.mp3 with exact boundaries', () => {
    const original = createMockBuffer(10, 1000);
    const sections = [
      { id: '1', title: 'Introduction', startSec: 1.0, endSec: 4.0 },
      { id: '2', title: 'Specifications', startSec: 5.0, endSec: 9.0 }
    ];

    const { takes } = Media.processAudioTakes(original, sections, 'mp3', 0.25);
    assert.equal(takes.length, 3, 'Must produce 2 section takes + 1 stitched master take');

    const sec1 = takes.find((t) => t.filename === '1.mp3');
    assert.ok(sec1, 'Take 1.mp3 must exist');
    assert.equal(sec1.isMaster, false);
    assert.equal(sec1.title, 'Section [Introduction]');

    const sec2 = takes.find((t) => t.filename === '2.mp3');
    assert.ok(sec2, 'Take 2.mp3 must exist');
    assert.equal(sec2.isMaster, false);
    assert.equal(sec2.title, 'Section [Specifications]');

    const master = takes.find((t) => t.filename === 'everything.mp3');
    assert.ok(master, 'everything.mp3 must exist');
    assert.equal(master.isMaster, true);
  });

  test('processAudioTakes exports 1.mp3, 2.mp3, and everything.mp3 with estimated boundaries when audio extends beyond Section 1', () => {
    const original = createMockBuffer(10, 1000); // 10 second buffer
    const sections = [
      { id: '1', title: 'Introduction', startSec: 0.0, endSec: 4.0 },
      { id: '2', title: 'Specifications', startSec: null, endSec: null }
    ];

    const { takes } = Media.processAudioTakes(original, sections, 'mp3', 0.25);
    assert.equal(takes.length, 3, 'Must reconcile Section 2 and export 1.mp3, 2.mp3, everything.mp3');

    const sec1 = takes.find((t) => t.filename === '1.mp3');
    assert.ok(sec1, 'Take 1.mp3 must exist');

    const sec2 = takes.find((t) => t.filename === '2.mp3');
    assert.ok(sec2, 'Estimated Take 2.mp3 must exist');
    assert.equal(sec2.isMaster, false);
    assert.ok(sec2.duration > 5.0, 'Estimated take duration must cover remaining audio');

    const master = takes.find((t) => t.filename === 'everything.mp3');
    assert.ok(master, 'everything.mp3 must exist');
    assert.equal(master.isMaster, true);
  });

  test('omits unreached trailing sections when audio does not extend beyond Section 1', () => {
    const original = createMockBuffer(4, 1000); // Exactly 4.0s recorded
    const sections = [
      { id: '1', title: 'Reached Section', startSec: 0.0, endSec: 4.0 },
      { id: '2', title: 'Unreached Section 2', startSec: null, endSec: null },
      { id: '3', title: 'Unreached Section 3', startSec: null, endSec: null }
    ];

    const { takes } = Media.processAudioTakes(original, sections, 'wav', 0.25);
    assert.equal(takes.length, 2, 'Must only include reached section take and stitched master take');

    const sec1 = takes.find((t) => t.filename === '1.wav');
    assert.ok(sec1, 'Take 1.wav must exist');

    const sec2 = takes.find((t) => t.filename === '2.wav');
    assert.equal(sec2, undefined, 'Unreached Section 2 must not produce a take');

    const sec3 = takes.find((t) => t.filename === '3.wav');
    assert.equal(sec3, undefined, 'Unreached Section 3 must not produce a take');

    const master = takes.find((t) => t.filename === 'everything.wav');
    assert.ok(master, 'Master take must exist');
  });
});

describe('TeleprompterMedia - MediaSession UI & Device Binding', () => {
  function createMockElement(initialClasses = []) {
    const classes = new Set(initialClasses);
    const listeners = {};
    const children = [];

    let innerHtml = '';
    const el = {
      value: '',
      textContent: '',
      get innerHTML() {
        return innerHtml;
      },
      set innerHTML(val) {
        innerHtml = val;
        if (!val) {
          children.length = 0;
        }
      },
      className: '',
      disabled: false,
      children,
      appendChild: (child) => {
        children.push(child);
      },
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        contains: (name) => classes.has(name),
      },
      addEventListener: (evt, fn) => {
        listeners[evt] = listeners[evt] || [];
        listeners[evt].push(fn);
      },
      dispatchEvent: (evt, payload = {}) => {
        (listeners[evt] || []).forEach((fn) => fn(payload));
      },
      click: () => {
        (listeners['click'] || []).forEach((fn) => fn({ target: el }));
      },
    };
    return el;
  }

  // Setup minimal global.document.createElement for Node environment tests
  const origDocument = global.document;
  before(() => {
    global.document = {
      createElement: (tag) => {
        const el = createMockElement();
        el.tagName = tag.toUpperCase();
        el.dataset = {};
        return el;
      },
    };
  });
  after(() => {
    global.document = origDocument;
  });

  test('exports VIDEO_FORMATS and AUDIO_FORMATS presets', () => {
    assert.ok(Array.isArray(Media.VIDEO_FORMATS), 'VIDEO_FORMATS must be an array');
    assert.ok(Array.isArray(Media.AUDIO_FORMATS), 'AUDIO_FORMATS must be an array');
    assert.ok(Media.VIDEO_FORMATS.some((f) => f.id === 'mp4'));
    assert.ok(Media.AUDIO_FORMATS.some((f) => f.id === 'mp3'));
  });

  test('bindUI binds controls, initializes dropdowns, and triggers updateFormatUI', () => {
    const session = new Media.MediaSession({
      activeRecordMode: 'video',
      activeVideoFormat: 'mp4',
      activeAudioFormat: 'mp3',
      activeAudioSource: 'browser'
    });

    const elements = {
      optAudioSource: createMockElement(),
      audioSourceBadge: createMockElement(),
      audioSourceDesc: createMockElement(),
      vuSource: createMockElement(),
      btnRefreshAudioDevices: createMockElement(),
      optRecordMode: createMockElement(),
      optRecordFormat: createMockElement(),
      recordingFormatGroup: createMockElement(),
      formatDesc: createMockElement(),
    };

    let formatChanged = false;
    session.bindUI(elements, {
      onFormatChange: (mode, vFmt, aFmt) => {
        formatChanged = true;
      }
    });

    assert.equal(session.activeRecordMode, 'video');
    assert.equal(elements.optRecordFormat.children.length, 2, 'Should populate 2 video formats');
    assert.ok(elements.formatDesc.textContent.includes('Universal MP4'));
    assert.ok(formatChanged, 'onFormatChange should have been invoked on initial bind');
  });

  test('updateFormatUI switches formats between video, audio, and off modes', () => {
    const session = new Media.MediaSession();
    const elements = {
      optRecordMode: createMockElement(),
      optRecordFormat: createMockElement(),
      recordingFormatGroup: createMockElement(),
      formatDesc: createMockElement(),
    };

    session.bindUI(elements);

    // Switch to audio mode
    elements.optRecordMode.value = 'audio';
    session.updateFormatUI();
    assert.equal(session.activeRecordMode, 'audio');
    assert.equal(elements.optRecordFormat.children.length, 3, 'Should populate 3 audio formats (mp3, wav, webm)');

    // Switch to off mode
    elements.optRecordMode.value = 'off';
    session.updateFormatUI();
    assert.equal(session.activeRecordMode, 'off');
    assert.ok(elements.recordingFormatGroup.classList.contains('hidden'), 'Format group must be hidden when mode is off');
  });

  test('updateAudioSourceUI populates hardware devices and updates badges', () => {
    const session = new Media.MediaSession();
    const elements = {
      optAudioSource: createMockElement(),
      audioSourceBadge: createMockElement(),
      audioSourceDesc: createMockElement(),
      vuSource: createMockElement(),
    };

    session.bindUI(elements);

    const devices = [
      { id: 'browser', name: 'Browser Microphone', raw_name: 'Browser Microphone' },
      { id: 'dev-1', name: 'Rode PodMic (Hardware)', raw_name: 'Rode PodMic USB' }
    ];

    session.updateAudioSourceUI('dev-1', devices);
    assert.equal(session.activeAudioSource, 'dev-1');
    assert.equal(session.activeAudioSourceName, 'Rode PodMic USB');
    assert.equal(elements.optAudioSource.children.length, 2);
    assert.equal(elements.audioSourceBadge.textContent, 'Rode PodMic USB');
    assert.equal(elements.vuSource.textContent, 'Rode PodMic USB');
  });

  test('setControlsDisabled enables and disables record mode and format elements', () => {
    const session = new Media.MediaSession();
    const elements = {
      optRecordMode: createMockElement(),
      optRecordFormat: createMockElement(),
    };

    session.bindUI(elements);
    session.setControlsDisabled(true);
    assert.equal(elements.optRecordMode.disabled, true);
    assert.equal(elements.optRecordFormat.disabled, true);

    session.setControlsDisabled(false);
    assert.equal(elements.optRecordMode.disabled, false);
    assert.equal(elements.optRecordFormat.disabled, false);
  });
});


