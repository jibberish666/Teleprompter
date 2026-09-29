/**
 * TeleprompterFormatter - Independent, testable script phrasing & cadence formatting engine.
 *
 * Encapsulates:
 * 1. Non-spoken cue stripping ([CAMERA 1], (pause), HOST:)
 * 2. Multi-word protected terms and capitalized entity cluster preservation
 * 3. Dynamic programming spoken-cadence chunking (strict 5–8 word lines)
 * 4. Dangling word elimination (prepositions, conjunctions, articles at line ends)
 * 5. Visual breath pause insertion at sentence and clause boundaries
 * 6. Structured token parsing for the teleprompter presentation layer
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node.js / CommonJS
    module.exports = factory();
  } else {
    // Browser global
    root.TeleprompterFormatter = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PREPOSITIONS = new Set([
    'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'of', 'into',
    'through', 'across', 'about', 'as', 'over', 'under', 'between',
    'after', 'before', 'during', 'without', 'against', 'among', 'via',
    'toward', 'towards', 'upon'
  ]);

  const CONJUNCTIONS = new Set([
    'and', 'or', 'but', 'nor', 'so', 'yet', 'because', 'although',
    'since', 'while', 'where', 'if', 'that', 'unless', 'until', 'whether'
  ]);

  const ARTICLES_AND_DETERMINERS = new Set([
    'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your',
    'his', 'her', 'its', 'our', 'their'
  ]);

  const DANGLING_WORDS = new Set([
    ...PREPOSITIONS,
    ...CONJUNCTIONS,
    ...ARTICLES_AND_DETERMINERS,
    'which', 'who', 'whom', 'whose'
  ]);

  // Key compound technical terms and noun phrases that must remain intact on a single line
  const DEFAULT_PROTECTED_TERMS = [
    'Turbo Technics VTR100 EVO',
    'Turbo Technics VSR3',
    'Turbo Technics',
    'VTR100 EVO',
    'variable geometry turbochargers',
    'variable geometry turbocharger',
    'proven flow measurement technology',
    'flow measurement technology',
    'passenger car and light commercial vehicle applications',
    'passenger cars and light commercial vehicles',
    'passenger car and light commercial vehicles',
    'light commercial vehicle applications',
    'light commercial vehicles',
    'enhanced actuator control',
    'actuator control',
    'aftermarket repair',
    'exhaust gas recirculation systems',
    'exhaust gas recirculation',
    'internal combustion engines',
    'internal combustion engine',
    'customer engagement in real time',
    'customer engagement',
    'real time'
  ];

  /**
   * 1. Strips non-spoken script cues, stage directions, and parentheticals.
   */
  function cleanCues(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      // Bracketed cues: [CAMERA 1], [PAUSE], [SLIDE 2], etc.
      .replace(/\[[^\]]*\]/g, ' ')
      // Common stage direction parentheticals: (pause), (smiling), (laughs), etc.
      .replace(/\((?:pause|smiling|smilingly|laughs?|laughter|sighs?|giggles?|clears throat|beat|applause|music|whispers?|fade in|fade out|cut to)[^)]*\)/gi, ' ')
      // Speaker tags at start of lines: "HOST:", "SPEAKER 1:", etc.
      .replace(/^[A-Z0-9\s_-]{2,25}:\s*/gm, '');
  }

  /**
   * Finds word ranges [start, end) that should not be split across line breaks.
   */
  function findProtectedRanges(rawWords, protectedTerms) {
    const terms = protectedTerms || DEFAULT_PROTECTED_TERMS;
    const protectedRanges = [];

    // Match explicit protected phrases
    for (const phrase of terms) {
      const pWords = phrase.split(' ');
      for (let i = 0; i <= rawWords.length - pWords.length; i++) {
        let matches = true;
        for (let p = 0; p < pWords.length; p++) {
          const wClean = rawWords[i + p].toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
          if (wClean !== pWords[p].toLowerCase()) {
            matches = false;
            break;
          }
        }
        if (matches) {
          protectedRanges.push({ start: i, end: i + pWords.length });
        }
      }
    }

    // Automatically protect capitalized proper noun clusters (2 to 6 words)
    for (let i = 0; i < rawWords.length; i++) {
      if (/^[A-Z0-9]/.test(rawWords[i])) {
        let j = i + 1;
        while (j < rawWords.length && /^[A-Z0-9]/.test(rawWords[j])) {
          j++;
        }
        if (j - i >= 2 && j - i <= 6) {
          protectedRanges.push({ start: i, end: j });
        }
      }
    }

    return protectedRanges;
  }

  function splitsProtected(idx, ranges) {
    for (const r of ranges) {
      if (idx > r.start && idx < r.end) return true;
    }
    return false;
  }

  /**
   * 2. Formats a single sentence into rhythmic 5–8 word teleprompter lines.
   */
  function chunkSentence(sentence, options = {}) {
    const rawWords = sentence.split(/\s+/).filter(Boolean);
    if (rawWords.length === 0) return [];
    if (rawWords.length <= 8) {
      return [rawWords.join(' ')];
    }

    const protectedRanges = findProtectedRanges(rawWords, options.protectedTerms);
    const n = rawWords.length;
    const dp = new Array(n + 1).fill(null).map(() => ({ cost: Infinity, prev: -1 }));
    dp[0] = { cost: 0, prev: -1 };

    for (let i = 0; i < n; i++) {
      if (dp[i].cost === Infinity) continue;

      for (let j = i + 1; j <= n; j++) {
        const wordCount = j - i;
        if (wordCount > 8) break; // Hard upper ceiling of 8 words per teleprompter line

        // Never break inside a protected multi-word phrase
        if (j < n && splitsProtected(j, protectedRanges)) continue;

        const lastWord = rawWords[j - 1];
        const cleanLast = lastWord.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
        const isDangling = j < n && DANGLING_WORDS.has(cleanLast);

        let cost = 0;
        // Word count scoring: strong target between 5 and 8 words
        if (wordCount >= 5 && wordCount <= 8) {
          if (wordCount === 6 || wordCount === 7) cost += 0;
          else if (wordCount === 5 || wordCount === 8) cost += 2;
        } else if (wordCount === 4) {
          cost += 80;
        } else if (wordCount === 3) {
          cost += 200;
        } else if (wordCount <= 2) {
          cost += 500;
        }

        // Dangling word penalty: heavily avoid ending lines with prepositions, conjunctions, or determiners
        if (isDangling) {
          cost += 1000;
        }

        // Punctuation break bonus (commas, semicolons, colons)
        if (lastWord.endsWith(',') || lastWord.endsWith(';') || lastWord.endsWith(':')) {
          cost -= 15;
        }

        // Forward momentum bonus: start next line with conjunction or preposition
        if (j < n) {
          const nextFirst = rawWords[j].toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
          if (CONJUNCTIONS.has(nextFirst)) {
            cost -= 8;
          } else if (PREPOSITIONS.has(nextFirst)) {
            cost -= 5;
          }
        }

        const totalCost = dp[i].cost + cost;
        if (totalCost < dp[j].cost) {
          dp[j] = { cost: totalCost, prev: i };
        }
      }
    }

    // Backtrack optimal line breaks
    const rawLines = [];
    let curr = n;
    while (curr > 0) {
      const prev = dp[curr].prev;
      if (prev === -1) {
        rawLines.unshift(rawWords.slice(0, curr).join(' '));
        break;
      }
      rawLines.unshift(rawWords.slice(prev, curr).join(' '));
      curr = prev;
    }

    // Insert visual breath pauses at major clause boundaries within long sentences (>= 20 words)
    const outputLines = [];
    let wordsSinceBreath = 0;
    for (let l = 0; l < rawLines.length; l++) {
      const line = rawLines[l];
      const count = line.split(/\s+/).length;
      outputLines.push(line);
      wordsSinceBreath += count;

      const endsWithComma = line.endsWith(',') || line.endsWith(';') || line.endsWith(':');
      const remainingWords = rawLines.slice(l + 1).reduce((acc, str) => acc + str.split(/\s+/).length, 0);

      if (endsWithComma && wordsSinceBreath >= 14 && remainingWords >= 10 && l < rawLines.length - 1) {
        outputLines.push(''); // Visual breathing pause
        wordsSinceBreath = 0;
      }
    }

    return outputLines;
  }

  /**
   * 3. Complete pipeline: cleans cues, splits sentences, chunks cadence, and formats script.
   */
  function formatScript(text, options = {}) {
    if (!text || typeof text !== 'string' || !text.trim()) return '';

    const cleaned = cleanCues(text);
    const rawParagraphs = cleaned.split(/\r?\n\s*\r?\n/);
    const formattedSections = [];

    for (const para of rawParagraphs) {
      const trimmedPara = para.replace(/\s+/g, ' ').trim();
      if (!trimmedPara) continue;

      // Split on full sentence boundaries (. ! ? ;)
      const sentenceRegex = /([.!?]+)(?:\s+|$)/g;
      const sentences = [];
      let lastIndex = 0;
      let match;

      while ((match = sentenceRegex.exec(trimmedPara)) !== null) {
        const sentenceText = trimmedPara.slice(lastIndex, match.index + match[1].length).trim();
        if (sentenceText) sentences.push(sentenceText);
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < trimmedPara.length) {
        const rem = trimmedPara.slice(lastIndex).trim();
        if (rem) sentences.push(rem);
      }

      const paraOutputLines = [];

      for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
        const sentence = sentences[sIdx];
        const sentenceLines = chunkSentence(sentence, options);

        if (paraOutputLines.length > 0 && sentenceLines.length > 0) {
          // Visual breath pause line between distinct sentences
          paraOutputLines.push('');
        }

        paraOutputLines.push(...sentenceLines);
      }

      formattedSections.push(paraOutputLines.join('\n'));
    }

    return formattedSections.join('\n\n');
  }

  /**
   * 4. Tokenizes script into structured line & word models for prompter rendering.
   */
  function parseTokens(rawText, options = {}) {
    if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
      return { lines: [], allWords: [] };
    }

    // Auto-format if unbroken long paragraphs exist
    const inputLines = rawText.split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean);
    const hasUnbrokenLongLines = inputLines.some((l) => l.split(/\s+/).length > 8);
    const effectiveText = (inputLines.length <= 3 && hasUnbrokenLongLines)
      ? formatScript(rawText, options)
      : rawText;

    const rawLines = effectiveText.split(/\r\n|\r|\n/);
    const linesData = [];
    const allWords = [];
    let globalWordIdx = 0;
    let prevWasBlank = false;

    for (let l = 0; l < rawLines.length; l++) {
      const trimmedLine = rawLines[l].trim();

      if (!trimmedLine) {
        // Blank line: breath pause or paragraph break
        if (!prevWasBlank && linesData.length > 0) {
          linesData.push({ lineIdx: linesData.length, words: [], isBlank: true });
          prevWasBlank = true;
        }
        continue;
      }

      prevWasBlank = false;
      const lineWords = trimmedLine.split(/\s+/).filter(Boolean);
      if (lineWords.length === 0) continue;

      // If a line is still over 8 words, format it with rhythmic phrasing
      const lineChunks = lineWords.length > 8
        ? formatScript(trimmedLine, options).split(/\r\n|\r|\n/).map((s) => s.trim())
        : [trimmedLine];

      for (const chunk of lineChunks) {
        if (!chunk) {
          if (!prevWasBlank && linesData.length > 0) {
            linesData.push({ lineIdx: linesData.length, words: [], isBlank: true });
            prevWasBlank = true;
          }
          continue;
        }
        prevWasBlank = false;
        const chunkWords = chunk.split(/\s+/).filter(Boolean);
        if (chunkWords.length === 0) continue;
        const lineObj = { lineIdx: linesData.length, words: [], isBlank: false };
        chunkWords.forEach((wordStr) => {
          const wObj = { globalIdx: globalWordIdx, lineIdx: lineObj.lineIdx, original: wordStr };
          lineObj.words.push(wObj);
          allWords.push(wObj);
          globalWordIdx++;
        });
        linesData.push(lineObj);
      }
    }

    // Remove trailing blank lines
    while (linesData.length > 0 && linesData[linesData.length - 1].isBlank) {
      linesData.pop();
    }

    return { lines: linesData, allWords: allWords };
  }

  return {
    PREPOSITIONS,
    CONJUNCTIONS,
    ARTICLES_AND_DETERMINERS,
    DANGLING_WORDS,
    DEFAULT_PROTECTED_TERMS,
    cleanCues,
    findProtectedRanges,
    chunkSentence,
    formatScript,
    formatScriptForPrompter: formatScript, // Backward compatibility alias
    parseTokens
  };
});
