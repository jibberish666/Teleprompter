/**
 * Unit tests for TeleprompterCues module using Node.js built-in test runner.
 * Run with: node test_cues.js
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const CuesModule = require('./static/cues.js');

class MockStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, val) {
    this.store.set(key, String(val));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

class MockConfigStore {
  constructor(initial = {}) {
    this.state = JSON.parse(JSON.stringify(initial));
  }
  get(path) {
    const parts = path.split('.');
    let cur = this.state;
    for (const p of parts) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[p];
    }
    return cur;
  }
  set(path, val) {
    const parts = path.split('.');
    let cur = this.state;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = val;
  }
  update(section, obj) {
    if (!this.state[section]) this.state[section] = {};
    Object.assign(this.state[section], obj);
  }
}

describe('TeleprompterCues - Pure Utilities', () => {
  test('cleanWord strips punctuation and lowercases', () => {
    assert.equal(CuesModule.cleanWord('Hello!'), 'hello');
    assert.equal(CuesModule.cleanWord('"Quoted"'), 'quoted');
    assert.equal(CuesModule.cleanWord('...Turbocharger...'), 'turbocharger');
    assert.equal(CuesModule.cleanWord(''), '');
    assert.equal(CuesModule.cleanWord(null), '');
  });

  test('hexToRgba converts 3- and 6-char hex properly', () => {
    assert.equal(CuesModule.hexToRgba('#fff', 0.5), 'rgba(255, 255, 255, 0.5)');
    assert.equal(CuesModule.hexToRgba('#f59e0b', 0.22), 'rgba(245, 158, 11, 0.22)');
    assert.equal(CuesModule.hexToRgba('invalid', 0.5), 'rgba(245, 158, 11, 0.5)');
  });
});

describe('TeleprompterCues - Difficult Words State & Logic', () => {
  let cues;
  let mockStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    cues = new CuesModule.RehearsalCues({ storage: mockStorage });
  });

  test('adds single and batch difficult words with deduplication', () => {
    assert.equal(cues.difficultWordsList.length, 0);

    // Single word
    const res1 = cues.addDifficultWord('Kubernetes');
    assert.equal(res1, true);
    assert.equal(cues.difficultWordsList.length, 1);
    assert.equal(cues.difficultWordsList[0], 'Kubernetes');

    // Duplicate (case-insensitive)
    const resDup = cues.addDifficultWord('kubernetes');
    assert.equal(resDup, false);
    assert.equal(cues.difficultWordsList.length, 1);

    // Batch input with punctuation and mixed delimiters
    const resBatch = cues.addDifficultWord('PostgreSQL; microservices, asynchronous\nteleprompter');
    assert.equal(resBatch, true);
    assert.equal(cues.difficultWordsList.length, 5);
  });

  test('removes word by index', () => {
    cues.addDifficultWord('alpha, beta, gamma');
    assert.equal(cues.difficultWordsList.length, 3);

    const removed = cues.removeDifficultWord(1); // remove beta
    assert.equal(removed, true);
    assert.deepEqual(cues.difficultWordsList, ['alpha', 'gamma']);
  });

  test('clears difficult words', () => {
    cues.addDifficultWord('word1, word2');
    const cleared = cues.clearDifficultWords();
    assert.equal(cleared, 2);
    assert.equal(cues.difficultWordsList.length, 0);
  });

  test('updates color and style styles', () => {
    cues.setColor('#10b981');
    assert.equal(cues.difficultColor, '#10b981');

    cues.setStyle('glow');
    assert.equal(cues.difficultStyle, 'glow');

    // Ignores invalid styles
    cues.setStyle('invalid-style');
    assert.equal(cues.difficultStyle, 'glow');
  });
});

describe('TeleprompterCues - Rehearsal Fumbles & Filtering', () => {
  let cues;
  let mockStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    cues = new CuesModule.RehearsalCues({ storage: mockStorage });
  });

  test('records fumbles and deduplicates by cleaned word', () => {
    const fumbles = [
      { word: 'pneumonia!', clean: 'pneumonia', reason: 'stumbled', index: 5 },
      { word: 'definitely', clean: 'definitely', reason: 'skipped', index: 12 },
      { word: 'pneumonia', clean: 'pneumonia', reason: 'repeated', index: 24 }, // duplicate
    ];

    let liveStyledCount = 0;
    const added = cues.recordFumbles(fumbles, () => {
      liveStyledCount++;
    });

    assert.equal(added, true);
    assert.equal(liveStyledCount, 3);
    assert.equal(cues.rehearsalWordsList.length, 2);

    const counts = cues.getCounts();
    assert.equal(counts.all, 2);
    assert.equal(counts.stumbled, 1);
    assert.equal(counts.skipped, 1);
    assert.equal(counts.repeated, 0);
  });

  test('promotes a rehearsal fumble into permanent difficult word', () => {
    cues.recordFumbles([{ word: 'idiosyncratic', clean: 'idiosyncratic', reason: 'stumbled' }]);
    assert.equal(cues.rehearsalWordsList.length, 1);
    assert.equal(cues.difficultWordsList.length, 0);

    const promoted = cues.promoteToDifficult(0);
    assert.equal(promoted, true);
    assert.equal(cues.rehearsalWordsList.length, 0);
    assert.equal(cues.difficultWordsList.length, 1);
    assert.equal(cues.difficultWordsList[0], 'idiosyncratic');
  });

  test('clears rehearsal fumbles by specific filter', () => {
    cues.recordFumbles([
      { word: 'w1', clean: 'w1', reason: 'skipped' },
      { word: 'w2', clean: 'w2', reason: 'skipped' },
      { word: 'w3', clean: 'w3', reason: 'stumbled' },
    ]);
    assert.equal(cues.rehearsalWordsList.length, 3);

    const removedSkipped = cues.clearRehearsalWords('skipped');
    assert.equal(removedSkipped, 2);
    assert.equal(cues.rehearsalWordsList.length, 1);
    assert.equal(cues.rehearsalWordsList[0].word, 'w3');

    // Clear remaining with 'all'
    const removedAll = cues.clearRehearsalWords('all');
    assert.equal(removedAll, 1);
    assert.equal(cues.rehearsalWordsList.length, 0);
  });
});

describe('TeleprompterCues - Word Cue Resolution (getCue)', () => {
  let cues;

  beforeEach(() => {
    cues = new CuesModule.RehearsalCues();
    cues.setStyle('pill');
    cues.addDifficultWord('algorithm');
    cues.recordFumbles([
      { word: 'parliament', clean: 'parliament', reason: 'skipped' },
      { word: 'monolithic', clean: 'monolithic', reason: 'stumbled' },
    ]);
  });

  test('resolves difficult words with highest priority', () => {
    const cue = cues.getCue('Algorithm!');
    assert.equal(cue.isDifficult, true);
    assert.equal(cue.isRehearsal, false);
    assert.equal(cue.classes, 'prompter-word-difficult style-pill');
  });

  test('resolves rehearsal fumble words when filter is "all"', () => {
    const cue = cues.getCue('parliament');
    assert.equal(cue.isDifficult, false);
    assert.equal(cue.isRehearsal, true);
    assert.equal(cue.reason, 'skipped');
    assert.equal(
      cue.classes,
      'prompter-word-difficult style-pill prompter-word-rehearsal prompter-word-rehearsal-skipped'
    );
  });

  test('respects syncPrompterWithFilter when filter is active', () => {
    cues.setSyncPrompterWithFilter(true);
    cues.setFilter('skipped');

    // 'parliament' is skipped -> matches active filter
    const cueSkipped = cues.getCue('parliament');
    assert.equal(cueSkipped.isRehearsal, true);

    // 'monolithic' is stumbled -> does NOT match active 'skipped' filter
    const cueStumbled = cues.getCue('monolithic');
    assert.equal(cueStumbled.isRehearsal, false);
    assert.equal(cueStumbled.classes, '');
  });

  test('returns blank cue for unflagged words', () => {
    const cue = cues.getCue('ordinary');
    assert.equal(cue.isDifficult, false);
    assert.equal(cue.isRehearsal, false);
    assert.equal(cue.classes, '');
  });
});

describe('TeleprompterCues - ConfigStore Persistence', () => {
  test('loads and synchronizes with configStore and storage', () => {
    const config = new MockConfigStore({
      ui: {
        difficult_words: ['cachedWord'],
        difficult_color: '#3b82f6',
        difficult_style: 'underline',
      },
      script: {
        rehearsal_words: [{ word: 'fumble1', clean: 'fumble1', reason: 'stumbled' }],
      },
    });

    const cues = new CuesModule.RehearsalCues({ configStore: config });
    assert.deepEqual(cues.difficultWordsList, ['cachedWord']);
    assert.equal(cues.difficultColor, '#3b82f6');
    assert.equal(cues.difficultStyle, 'underline');
    assert.equal(cues.rehearsalWordsList.length, 1);

    // Add new word and verify written to config
    cues.addDifficultWord('newWord');
    assert.deepEqual(config.get('ui.difficult_words'), ['cachedWord', 'newWord']);
  });
});
