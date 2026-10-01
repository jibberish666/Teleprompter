/**
 * End-to-End Simulation: Multi-section read-through with dropped boundary words,
 * cadence lookback, delayed stop click, and full MP3 export.
 * Run with: node test_simulation.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Load embedded lamejs for MP3 encoding in Node
eval(fs.readFileSync(path.join(__dirname, 'static/lame.min.js'), 'utf8'));
global.lamejs = lamejs;

const Formatter = require('./static/formatter.js');
const Timeline = require('./static/timeline.js');
const Media = require('./static/media.js');

function createMockBuffer(seconds, sampleRate = 1000) {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;
  }
  return {
    numberOfChannels: 1,
    sampleRate: sampleRate,
    length: length,
    duration: seconds,
    getChannelData: () => data,
  };
}

describe('End-to-End Multi-Section Speech & Export Simulation', () => {
  test('synthetic multi-section read-through with dropped boundary words and delayed stop click produces 1.mp3, 2.mp3, and everything.mp3', () => {
    const rawScript = `[1]
Welcome to the technical overview of our machinery.
[2]
Detailed specifications include high precision balancing and calibrated sensors.`;

    const { allWords, sections } = Formatter.parseTokens(rawScript);
    assert.equal(sections.length, 2, 'Script must parse into exactly 2 sections');

    let elapsedSec = 0;
    const timeline = new Timeline.SectionTimeline(sections, () => elapsedSec);

    // 1. Section 1 speech: words 0 to 6 spoken from t=1.0s to t=5.0s
    elapsedSec = 1.0;
    timeline.wordSeen(allWords[0], true);
    assert.equal(sections[0].startSec, 0.9);

    for (let i = 1; i <= 6; i++) {
      elapsedSec = 1.0 + i * 0.6; // ~600ms per word
      timeline.wordSeen(allWords[i], true);
    }
    const sec1LastWordTime = elapsedSec; // ~4.6s

    // 2. Section 2 begins: Whisper drops first 3 words (indices 7, 8, 9)
    // First recognized word in Section 2 is index 10 ("specifications") at t=6.5s
    elapsedSec = 6.5;
    const sec2FirstRecognized = allWords[10];
    assert.equal(sec2FirstRecognized.sectionId, '2');
    assert.ok(sec2FirstRecognized.globalIdx > sections[1].startIndex, 'Must simulate dropped initial boundary words');

    timeline.wordSeen(sec2FirstRecognized, true);

    // Lookback: 2 missed words * 0.4s = 0.8s => 6.5 - 0.8 = 5.7s
    // Section 1 closes at 5.7s, Section 2 starts at 5.7s (cleanly anchored after Section 1 speech)
    assert.ok(sections[0].endSec >= sec1LastWordTime, 'Section 1 endSec must cover all spoken words');
    assert.equal(sections[0].endSec, 5.7);
    assert.equal(sections[1].startSec, 5.7);

    // Speak remaining words of Section 2 up to t=10.0s
    for (let i = 11; i < allWords.length; i++) {
      elapsedSec = 6.5 + (i - 10) * 0.5;
      timeline.wordSeen(allWords[i], true);
    }
    const speechEndTime = elapsedSec; // ~9.5s

    // 3. User clicks Stop: 1200ms flush window elapses
    const stopClickTime = speechEndTime + 0.3; // 9.8s
    const flushDelaySec = 1.2; // 1200ms
    const sessionEndTime = stopClickTime + flushDelaySec; // 11.0s

    timeline.close(sessionEndTime);
    const resolvedMarkers = timeline.resolveBoundaries(sessionEndTime);

    assert.equal(resolvedMarkers[0].id, '1');
    assert.equal(resolvedMarkers[1].id, '2');
    assert.ok(resolvedMarkers[0].startSec !== null && resolvedMarkers[0].endSec !== null);
    assert.ok(resolvedMarkers[1].startSec !== null && resolvedMarkers[1].endSec !== null);

    // 4. Feed audio buffer and resolved markers into processAudioTakes
    const sessionBuffer = createMockBuffer(sessionEndTime, 1000);
    const { takes } = Media.processAudioTakes(sessionBuffer, resolvedMarkers, 'mp3', 0.25);

    assert.equal(takes.length, 3, 'Must generate 1.mp3, 2.mp3, and everything.mp3');

    const take1 = takes.find((t) => t.filename === '1.mp3');
    assert.ok(take1, '1.mp3 take must exist');
    assert.equal(take1.isMaster, false);
    assert.ok(take1.duration > 0, '1.mp3 must have positive duration');
    assert.ok(take1.blob && (take1.blob.length > 0 || take1.blob.size > 0), '1.mp3 must contain MP3 data');

    const take2 = takes.find((t) => t.filename === '2.mp3');
    assert.ok(take2, '2.mp3 take must exist');
    assert.equal(take2.isMaster, false);
    assert.ok(take2.duration > 0, '2.mp3 must have positive duration');
    assert.ok(take2.blob && (take2.blob.length > 0 || take2.blob.size > 0), '2.mp3 must contain MP3 data');

    const takeEverything = takes.find((t) => t.filename === 'everything.mp3');
    assert.ok(takeEverything, 'everything.mp3 master take must exist');
    assert.equal(takeEverything.isMaster, true);
    assert.ok(takeEverything.duration > 0, 'everything.mp3 must have positive duration');
    assert.ok(takeEverything.blob && (takeEverything.blob.length > 0 || takeEverything.blob.size > 0), 'everything.mp3 must contain MP3 data');
  });

  test('synthetic multi-section read-through where Whisper misses Section 2 entirely recovers boundaries and produces all MP3s', () => {
    const rawScript = `[1]
First section speech.
[2]
Second section speech never recognized by Whisper.`;

    const { sections } = Formatter.parseTokens(rawScript);
    assert.equal(sections.length, 2);

    let elapsedSec = 0;
    const timeline = new Timeline.SectionTimeline(sections, () => elapsedSec);

    // Section 1 tracked and ended at 5.0s
    elapsedSec = 1.0;
    timeline.wordSeen({ sectionId: '1', original: 'First', globalIdx: 0 }, true);
    elapsedSec = 5.0;
    sections[0].endSec = 5.0;
    timeline.activeId = '2'; // User stepped into Section 2

    // Section 2 was spoken between 5.0s and 9.5s, but Whisper emitted zero tokens!
    // User clicks Stop at 9.8s + 1.2s flush = 11.0s
    const sessionEndTime = 11.0;
    timeline.close(sessionEndTime);
    const resolvedMarkers = timeline.resolveBoundaries(sessionEndTime);

    // Boundary resolver recovered Section 2 using unaccounted duration
    assert.equal(resolvedMarkers[0].endSec, 5.0);
    assert.equal(resolvedMarkers[1].startSec, 5.0);
    assert.equal(resolvedMarkers[1].endSec, 11.0);

    const sessionBuffer = createMockBuffer(sessionEndTime, 1000);
    const { takes } = Media.processAudioTakes(sessionBuffer, resolvedMarkers, 'mp3', 0.25);

    assert.equal(takes.length, 3, 'Must guarantee 1.mp3, 2.mp3, and everything.mp3 are created');
    assert.ok(takes.some((t) => t.filename === '1.mp3'));
    assert.ok(takes.some((t) => t.filename === '2.mp3'));
    assert.ok(takes.some((t) => t.filename === 'everything.mp3'));
  });
});
