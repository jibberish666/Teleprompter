/**
 * Unit tests for TeleprompterFormatter module using Node.js built-in test runner.
 * Run with: node --test test_formatter.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Formatter = require('./static/formatter.js');

describe('TeleprompterFormatter - Cue & Metadata Stripping', () => {
  test('strips bracketed camera and stage cues', () => {
    const input = '[CAMERA 1 - CLOSE UP] Welcome to the presentation [PAUSE] today.';
    const cleaned = Formatter.cleanCues(input);
    assert.doesNotMatch(cleaned, /\[CAMERA 1/);
    assert.doesNotMatch(cleaned, /\[PAUSE\]/);
    assert.match(cleaned, /Welcome to the presentation/);
  });

  test('strips parenthetical stage directions', () => {
    const input = 'Good morning everyone (smiling) and thank you (pause) for coming.';
    const cleaned = Formatter.cleanCues(input);
    assert.doesNotMatch(cleaned, /\(smiling\)/);
    assert.doesNotMatch(cleaned, /\(pause\)/);
    assert.match(cleaned, /Good morning everyone/);
  });

  test('strips leading speaker labels', () => {
    const input = 'HOST: Welcome to our show.\nSPEAKER 2: Thank you for having me.';
    const cleaned = Formatter.cleanCues(input);
    assert.doesNotMatch(cleaned, /HOST:/);
    assert.doesNotMatch(cleaned, /SPEAKER 2:/);
    assert.match(cleaned, /Welcome to our show/);
  });

  test('handles empty or non-string inputs gracefully', () => {
    assert.equal(Formatter.cleanCues(''), '');
    assert.equal(Formatter.cleanCues(null), '');
    assert.equal(Formatter.cleanCues(undefined), '');
  });
});

describe('TeleprompterFormatter - Protected Terms Preservation', () => {
  test('protects explicit multi-word technical terms from being split', () => {
    const sentence = 'Our new line includes variable geometry turbochargers with advanced electronics.';
    const lines = Formatter.chunkSentence(sentence);

    // Join all lines with newline and ensure "variable geometry turbochargers" appears unbroken on one line
    const unbrokenPhraseFound = lines.some((line) => line.includes('variable geometry turbochargers'));
    assert.equal(
      unbrokenPhraseFound,
      true,
      'Protected term "variable geometry turbochargers" should not be split across lines'
    );
  });

  test('protects capitalized entity clusters', () => {
    const words = 'The Turbo Technics VTR100 EVO delivers peak performance'.split(' ');
    const ranges = Formatter.findProtectedRanges(words);
    assert.ok(ranges.length > 0, 'Capitalized cluster should be identified');
    // Ensure "Turbo Technics VTR100 EVO" range covers those 4 words
    const cluster = ranges.find((r) => r.end - r.start >= 4);
    assert.ok(cluster, 'Expected cluster covering at least 4 capitalized words');
  });
});

describe('TeleprompterFormatter - Spoken Cadence & Line Length Rules', () => {
  test('keeps short sentences (<= 8 words) intact on a single line', () => {
    const sentence = 'Good morning team and welcome back.';
    const lines = Formatter.chunkSentence(sentence);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], sentence);
  });

  test('chunks long sentences into 5–8 word spoken cadence lines', () => {
    const sentence = 'Variable geometry turbochargers are increasingly common in modern passenger cars and light commercial vehicles because they provide optimal boost across the entire engine operating range.';
    const lines = Formatter.chunkSentence(sentence).filter((l) => l.trim().length > 0);

    for (const line of lines) {
      const count = line.split(/\s+/).filter(Boolean).length;
      assert.ok(
        count >= 4 && count <= 8,
        `Line length ${count} outside acceptable teleprompter range (4-8): "${line}"`
      );
    }
  });

  test('avoids hanging prepositions, conjunctions, and articles at line ends', () => {
    const sentence = 'We designed the new system specifically for tracking customer engagement in real time with high reliability.';
    const lines = Formatter.chunkSentence(sentence).filter((l) => l.trim().length > 0);

    for (let i = 0; i < lines.length - 1; i++) {
      const lineWords = lines[i].split(/\s+/).filter(Boolean);
      const lastWord = lineWords[lineWords.length - 1].toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
      assert.ok(
        !Formatter.DANGLING_WORDS.has(lastWord),
        `Line ${i} should not end with dangling word "${lastWord}": "${lines[i]}"`
      );
    }
  });
});

describe('TeleprompterFormatter - Full Script Formatting & Breath Pauses', () => {
  test('inserts visual breath pause (blank line) between distinct sentences', () => {
    const script = 'First sentence is short. Second sentence is also quite brief.';
    const formatted = Formatter.formatScript(script);
    const sections = formatted.split('\n\n');
    assert.ok(sections.length >= 2, 'Expected blank line separation between distinct thoughts');
  });

  test('formats automotive technical script matching teleprompter cadence guidelines', () => {
    const raw = 'Variable geometry turbochargers are increasingly common in modern passenger cars and light commercial vehicles because they provide optimal boost across the entire engine operating range.';
    const formatted = Formatter.formatScript(raw);
    const lines = formatted.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    assert.ok(lines.length >= 3, 'Expected sentence to be broken into cadence lines');
    // Check that compound passenger cars phrase is intact
    assert.ok(
      lines.some((l) => l.includes('passenger cars and light commercial vehicles')),
      'Should keep "passenger cars and light commercial vehicles" intact'
    );
  });
});

describe('TeleprompterFormatter - Token Parsing for Presentation Layer', () => {
  test('returns structured lines and contiguous word indices', () => {
    const script = 'Hello world.\n\nThis is a test.';
    const { lines, allWords } = Formatter.parseTokens(script);

    assert.ok(lines.length > 0, 'Expected parsed lines');
    assert.ok(allWords.length > 0, 'Expected parsed words');

    // Verify word objects
    for (let i = 0; i < allWords.length; i++) {
      assert.equal(allWords[i].globalIdx, i, `Word globalIdx should be strictly contiguous at ${i}`);
      assert.ok(typeof allWords[i].lineIdx === 'number', 'lineIdx must be a number');
      assert.ok(typeof allWords[i].original === 'string', 'original must be string');
    }

    // Verify blank line representation
    const blankLine = lines.find((l) => l.isBlank);
    assert.ok(blankLine, 'Expected at least one blank line object for breath pause');
    assert.equal(blankLine.words.length, 0);
  });

  test('handles empty or whitespace text gracefully', () => {
    const emptyResult = Formatter.parseTokens('');
    assert.deepEqual(emptyResult.lines, []);
    assert.deepEqual(emptyResult.allWords, []);
    assert.deepEqual(emptyResult.sections, []);

    const whitespaceResult = Formatter.parseTokens('   \n\n  ');
    assert.deepEqual(whitespaceResult.lines, []);
    assert.deepEqual(whitespaceResult.allWords, []);
    assert.deepEqual(whitespaceResult.sections, []);
  });
});

describe('TeleprompterFormatter - Section Parsing & Tagging', () => {
  test('preserves standalone bracketed section lines while stripping inline cues', () => {
    const script = `[1]\nWelcome to the presentation [PAUSE] today.\n[2]\nBy balancing the core assembly (smiling) we achieve peak performance.`;
    const cleaned = Formatter.cleanCues(script);

    assert.match(cleaned, /\[1\]/);
    assert.match(cleaned, /\[2\]/);
    assert.doesNotMatch(cleaned, /\[PAUSE\]/);
    assert.doesNotMatch(cleaned, /\(smiling\)/);
  });

  test('sanitizes bracketed section names into filesystem-safe identifiers', () => {
    assert.equal(Formatter.sanitizeSectionFilename('1'), '1');
    assert.equal(Formatter.sanitizeSectionFilename('Take 2: Intro'), 'Take_2_Intro');
    assert.equal(Formatter.sanitizeSectionFilename('Section / Part #3!'), 'Section_Part_3');
    assert.equal(Formatter.sanitizeSectionFilename(''), 'section');
  });

  test('parses sections, tags words, and creates non-spoken header line objects', () => {
    const script = `[1]\nFirst sentence here.\n\n[2]\nSecond sentence follows.`;
    const { lines, allWords, sections } = Formatter.parseTokens(script);

    assert.equal(sections.length, 2);
    assert.equal(sections[0].id, '1');
    assert.equal(sections[0].title, '1');
    assert.equal(sections[1].id, '2');
    assert.equal(sections[1].title, '2');

    // Section header lines in linesData must not have speech words
    const headerLines = lines.filter((l) => l.isSectionHeader);
    assert.equal(headerLines.length, 2);
    assert.equal(headerLines[0].words.length, 0, 'Section header line must have no speech words');
    assert.equal(headerLines[0].sectionId, '1');
    assert.equal(headerLines[1].sectionId, '2');

    // Speech words must not contain the section header titles
    assert.equal(allWords.some((w) => w.original === '[1]' || w.original === '[2]'), false);

    // Words must be mapped to their parent sections
    assert.equal(allWords[0].sectionId, '1');
    assert.equal(allWords[0].sectionTitle, '1');
    assert.equal(allWords[allWords.length - 1].sectionId, '2');
    assert.equal(allWords[allWords.length - 1].sectionTitle, '2');
  });

  test('defaults leading text before first section header to section "intro"', () => {
    const script = `Opening greeting before any tag.\n\n[Main Body]\nHere is the detailed content.`;
    const { lines, allWords, sections } = Formatter.parseTokens(script);

    assert.equal(sections.length, 2);
    assert.equal(sections[0].id, 'intro');
    assert.equal(sections[0].title, 'intro');
    assert.equal(sections[1].id, 'Main_Body');
    assert.equal(sections[1].title, 'Main Body');

    const firstWord = allWords[0];
    assert.equal(firstWord.original, 'Opening');
    assert.equal(firstWord.sectionId, 'intro');

    const lastWord = allWords[allWords.length - 1];
    assert.equal(lastWord.original, 'content.');
    assert.equal(lastWord.sectionId, 'Main_Body');
  });

  test('maintains backward compatibility when script has no bracketed sections', () => {
    const script = `Just a standard single take script.\nNo section markers anywhere.`;
    const { lines, allWords, sections } = Formatter.parseTokens(script);

    assert.equal(sections.length, 0, 'Expected empty sections array when no section tags exist');
    assert.equal(lines.some((l) => l.isSectionHeader), false);
    for (const w of allWords) {
      assert.equal(w.sectionId, null);
    }
  });
});

