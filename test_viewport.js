/**
 * Unit tests for TeleprompterViewport module using Node.js built-in test runner.
 * Run with: node test_viewport.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const ViewportModule = require('./static/viewport.js');

describe('TeleprompterViewport - Typography & Geometry Calculations', () => {
  test('calculates responsive line height with comfortable default (1.35) and 28px clamp', () => {
    assert.equal(ViewportModule.getLineHeightForFontSize(25), 34); // 25 * 1.35 = 33.75 -> 34
    assert.equal(ViewportModule.getLineHeightForFontSize(30), 41); // 30 * 1.35 = 40.5 -> 41
    assert.equal(ViewportModule.getLineHeightForFontSize(36), 49); // 36 * 1.35 = 48.6 -> 49
    assert.equal(ViewportModule.getLineHeightForFontSize(40), 54); // 40 * 1.35 = 54
    assert.equal(ViewportModule.getLineHeightForFontSize(15), 28); // 15 * 1.35 = 20.25 -> clamped to 28
    assert.equal(ViewportModule.getLineHeightForFontSize(0), 28);  // clamped to 28
    assert.equal(ViewportModule.getLineHeightForFontSize(null), 49); // fallback 36 -> 49
  });

  test('calculates responsive line height for explicit tight, comfortable, and relaxed presets', () => {
    // 36px baseline
    assert.equal(ViewportModule.getLineHeightForFontSize(36, 'tight'), 43);       // 36 * 1.20 = 43.2 -> 43
    assert.equal(ViewportModule.getLineHeightForFontSize(36, 'comfortable'), 49); // 36 * 1.35 = 48.6 -> 49
    assert.equal(ViewportModule.getLineHeightForFontSize(36, 'relaxed'), 54);     // 36 * 1.50 = 54
  });

  test('calculates negative translateY scroll offset', () => {
    assert.equal(ViewportModule.getScrollTranslateY(0, 45), 0);
    assert.equal(ViewportModule.getScrollTranslateY(1, 45), -45);
    assert.equal(ViewportModule.getScrollTranslateY(5, 50), -250);
    assert.equal(ViewportModule.getScrollTranslateY(-2, 40), 0);
  });
});

describe('TeleprompterViewport - Script Line HTML Rendering', () => {
  test('returns placeholder text when linesData is empty', () => {
    const emptyHTML = ViewportModule.renderLinesHTML([]);
    assert.match(emptyHTML, /Paste script & press Start Session\.\.\./);
  });

  test('renders section headers and blank lines accurately', () => {
    const lines = [
      { lineIdx: 0, isSectionHeader: true, sectionTitle: 'Overview' },
      { lineIdx: 1, isBlank: true },
    ];
    const html = ViewportModule.renderLinesHTML(lines);
    assert.match(html, /prompter-line-section/);
    assert.match(html, /\[Overview\]/);
    assert.match(html, /prompter-line-blank/);
  });

  test('renders word spans with cue styling from cuesManager', () => {
    const mockCues = {
      getCue(word) {
        if (word === 'Docker') {
          return { classes: 'prompter-word-difficult style-pill' };
        }
        if (word === 'Kubernetes') {
          return { classes: 'prompter-word-difficult style-pill prompter-word-rehearsal prompter-word-rehearsal-stumbled' };
        }
        return { classes: '' };
      },
    };

    const lines = [
      {
        lineIdx: 2,
        words: [
          { original: 'Deploying', globalIdx: 0 },
          { original: 'Docker', globalIdx: 1 },
          { original: 'on', globalIdx: 2 },
          { original: 'Kubernetes', globalIdx: 3 },
        ],
      },
    ];

    const html = ViewportModule.renderLinesHTML(lines, mockCues);

    assert.match(html, /id="w-0" class="prompter-word">Deploying</);
    assert.match(html, /id="w-1" class="prompter-word prompter-word-difficult style-pill">Docker</);
    assert.match(html, /id="w-2" class="prompter-word">on</);
    assert.match(html, /id="w-3" class="prompter-word prompter-word-difficult style-pill prompter-word-rehearsal prompter-word-rehearsal-stumbled">Kubernetes</);
  });
});

describe('TeleprompterViewport - PrompterViewport Engine', () => {
  test('calculates initial geometry, font sizes, and line spacing updates', () => {
    const vp = new ViewportModule.PrompterViewport({ initialFontSize: 20 });
    assert.equal(vp.fontSize, 20);
    assert.equal(vp.lineHeight, 28); // 20 * 1.35 = 27 -> clamped to 28

    const newLh = vp.setFontSize(30);
    assert.equal(vp.fontSize, 30);
    assert.equal(newLh, 41); // 30 * 1.35 = 40.5 -> 41
    assert.equal(vp.lineHeight, 41);

    const relaxedLh = vp.setLineSpacing('relaxed');
    assert.equal(vp.lineSpacing, 'relaxed');
    assert.equal(relaxedLh, 45); // 30 * 1.50 = 45
    assert.equal(vp.lineHeight, 45);

    const tightLh = vp.setLineSpacing('tight');
    assert.equal(vp.lineSpacing, 'tight');
    assert.equal(tightLh, 36); // 30 * 1.20 = 36
    assert.equal(vp.lineHeight, 36);
  });

  function createMockContainer(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
      style: {},
      classList: {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        contains(c) { return classes.has(c); },
        [Symbol.iterator]() { return classes.values(); }
      }
    };
  }

  test('setFontFamily updates font class and property', () => {
    const mockContainer = createMockContainer();
    const vp = new ViewportModule.PrompterViewport({
      linesContainer: mockContainer,
      initialFontFamily: 'open-sans'
    });
    assert.equal(vp.fontFamily, 'open-sans');
    assert.ok(mockContainer.classList.contains('font-teleprompter-open-sans'));

    vp.setFontFamily('lexend');
    assert.equal(vp.fontFamily, 'lexend');
    assert.ok(mockContainer.classList.contains('font-teleprompter-lexend'));
    assert.ok(!mockContainer.classList.contains('font-teleprompter-open-sans'));
  });

  test('setFontWeight updates font weight style property', () => {
    const mockContainer = createMockContainer();
    const vp = new ViewportModule.PrompterViewport({
      linesContainer: mockContainer,
      initialFontWeight: 500
    });
    assert.equal(vp.fontWeight, 500);
    assert.equal(mockContainer.style.fontWeight, '500');

    vp.setFontWeight(700);
    assert.equal(vp.fontWeight, 700);
    assert.equal(mockContainer.style.fontWeight, '700');
  });

  test('scrollToLine updates currentLineIndex and returns translateY', () => {
    const vp = new ViewportModule.PrompterViewport({ initialFontSize: 36 }); // default comfortable lh = 49
    const ty = vp.scrollToLine(3);
    assert.equal(vp.currentLineIndex, 3);
    assert.equal(ty, -147);
  });

  test('highlightWord tracks active word object and line index', () => {
    const vp = new ViewportModule.PrompterViewport({ initialFontSize: 25 });
    const allWords = [
      { original: 'Line0-w0', globalIdx: 0, lineIdx: 0 },
      { original: 'Line0-w1', globalIdx: 1, lineIdx: 0 },
      { original: 'Line1-w2', globalIdx: 2, lineIdx: 1 },
      { original: 'Line2-w3', globalIdx: 3, lineIdx: 2 },
    ];

    const res1 = vp.highlightWord(2, allWords);
    assert.equal(res1.lineIdx, 1);
    assert.equal(res1.activeWordObj.original, 'Line1-w2');
    assert.equal(vp.currentWordIndex, 2);
    assert.equal(vp.currentLineIndex, 1);

    const res2 = vp.highlightWord(3, allWords);
    assert.equal(res2.lineIdx, 2);
    assert.equal(res2.activeWordObj.original, 'Line2-w3');
  });
});
