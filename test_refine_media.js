/**
 * Tests for post-recording boundary refinement helpers in TeleprompterMedia.
 * Run with: node --test test_refine_media.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

eval(fs.readFileSync(path.join(__dirname, 'static/lame.min.js'), 'utf8'));
global.lamejs = lamejs;

const Media = require('./static/media.js');

describe('applyRefinedBoundaries', () => {
  test('overwrites matched sections and keeps live boundaries for the rest', () => {
    const sections = [
      { id: 's1', startSec: 0, endSec: 15 },
      { id: 's2', startSec: 15, endSec: 18 },
      { id: 's3', startSec: null, endSec: null },
    ];
    Media.applyRefinedBoundaries(sections, {
      s1: { startSec: 0.2, endSec: 9.5 },
      s2: { startSec: 10.4, endSec: 18 },
      s3: null,
    });
    assert.equal(sections[0].endSec, 9.5);
    assert.equal(sections[1].startSec, 10.4);
    assert.equal(sections[2].startSec, null);
  });

  test('ignores a null map and invalid ranges', () => {
    const sections = [{ id: 's1', startSec: 1, endSec: 2 }];
    Media.applyRefinedBoundaries(sections, null);
    Media.applyRefinedBoundaries(sections, { s1: { startSec: 5, endSec: 3 } });
    assert.equal(sections[0].startSec, 1);
    assert.equal(sections[0].endSec, 2);
  });
});

describe('audioBufferToPcm16k', () => {
  test('downmixes stereo 48 kHz to mono 16 kHz with a 3:1 length ratio', () => {
    const len = 4800;
    const left = new Float32Array(len).fill(0.5);
    const right = new Float32Array(len).fill(-0.5);
    const buf = {
      numberOfChannels: 2,
      sampleRate: 48000,
      length: len,
      getChannelData: (c) => (c === 0 ? left : right),
    };
    const pcm = Media.audioBufferToPcm16k(buf);
    assert.equal(pcm.length, 1600);
    assert.equal(pcm[10], 0); // opposite channels cancel in the mono mix
  });
});

describe('processAudioTakes with onProgress', () => {
  test('emits progress updates during section slicing and master assembly', () => {
    const len = 48000 * 4;
    const buf = {
      numberOfChannels: 1,
      sampleRate: 48000,
      length: len,
      duration: 4.0,
      getChannelData: () => new Float32Array(len),
    };
    const sections = [
      { id: '1', title: 'Intro', startSec: 0, endSec: 2 },
      { id: '2', title: 'Outro', startSec: 2, endSec: 4 },
    ];
    const progressReports = [];
    Media.processAudioTakes(buf, sections, 'wav', 0.25, (p) => {
      progressReports.push(p);
    });

    assert.ok(progressReports.length >= 2, 'Should emit at least two progress reports');
    const slicingReports = progressReports.filter(p => p.phase === 'slicing');
    const masterReports = progressReports.filter(p => p.phase === 'master');
    assert.ok(slicingReports.length >= 1, 'Should emit slicing reports');
    assert.ok(masterReports.length >= 1, 'Should emit master assembly report');
  });
});
