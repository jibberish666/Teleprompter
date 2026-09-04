---
name: teleprompter-text-formatter
description: >-
  Formats, chunks, and cadences raw or script text specifically for teleprompter presentation.
  Breaks text into natural 5–8 word spoken lines, preserves semantic noun phrases and compound terms,
  eliminates trailing prepositions/conjunctions, inserts thought/breath breaks, and strips metadata.
---

# Teleprompter Text Formatter Skill

This skill governs the automatic formatting, cadence chunking, and preparation of raw script text for teleprompter display and real-time speech alignment.

When given raw or script text to format, always process and format it according to the strict teleprompter delivery rules below.

---

## 1. Core Formatting & Chunking Rules

1. **Spoken Cadence Line Length (5 to 8 words)**:
   - Break sentences into natural spoken cadence lines containing **5 to 8 words per line**.
   - Avoid short fragments (2–4 words) unless a single short exclamation or deliberate pause is necessary.
   - Do not let lines run excessively long (9+ words), which causes eye strain and tracking difficulty across wide teleprompter viewports.

2. **Preserve Semantic Phrases & Compound Terms**:
   - Keep semantic phrases, noun clusters, and technical or compound terms intact on a single line.
   - **Never break** phrases like:
     - *"variable geometry turbochargers"*
     - *"passenger cars and light commercial vehicles"*
     - *"exhaust gas recirculation systems"*
     - *"internal combustion engines"*
   - Adjust the break point before or after the phrase to ensure the entire cluster stays unified.

3. **No Hanging Prepositions or Conjunctions**:
   - Never end a line with an open preposition or conjunction (such as *"of"*, *"for"*, *"and"*, *"in"*, *"with"*, *"to"*, *"at"*, *"by"*, *"on"*, *"but"*, *"or"*).
   - Move the preposition or conjunction down to the beginning of the subsequent line so each line starts with grammatical momentum.

4. **Thought & Breath Breaks**:
   - Insert a **single blank line** between distinct thoughts, major sentence boundaries, or natural breath/pause points.
   - This visual whitespace gives the speaker room to breathe and signals topic shifts.

5. **Strip Non-Spoken Script Metadata**:
   - Remove script metadata, stage directions, scene headings, camera cues, audio cues, and parentheticals (e.g. `[PAUSE]`, `(smiling)`, `INT. STUDIO - DAY`, `HOST:`, `SLIDE 3:`) unless the user explicitly requests to keep them.

6. **Ready-to-Paste Teleprompter Output**:
   - When updating files or returning formatted text to the user, output clean, formatted text that can be pasted directly into the teleprompter editor or loaded by the app without further cleanup.

---

## 2. Chunking Examples

### Example 1: Technical & Automotive Script

#### Raw Input:
```text
Variable geometry turbochargers are increasingly common in modern passenger cars and light commercial vehicles because they provide optimal boost across the entire engine operating range.
```

#### Formatted Teleprompter Output:
```text
Variable geometry turbochargers are increasingly common
in modern passenger cars and light commercial vehicles,

because they provide optimal boost
across the entire engine operating range.
```

### Example 2: Explainer / Presentation Script

#### Raw Input:
```text
[CAMERA 1 - CLOSE UP] Good morning team. Today we are announcing the rollout of our new internal analytics platform, designed specifically for tracking customer engagement in real time. (pause) Let's dive straight into the key architecture updates.
```

#### Formatted Teleprompter Output:
```text
Good morning team, today we are announcing
the rollout of our new internal analytics platform,

designed specifically for tracking customer engagement
in real time.

Let's dive straight into
the key architecture updates.
```

---

## 3. Formatting Checklist

Before returning or writing formatted teleprompter text, verify:
- [ ] Are all lines between 5 and 8 words (avoiding 2–4 word snippets)?
- [ ] Are technical noun phrases and compound concepts kept together?
- [ ] Are line endings clean without dangling prepositions (*"of"*, *"for"*, *"with"*, etc.) or conjunctions (*"and"*, *"or"*)?
- [ ] Is there a blank line separating distinct thoughts or breath points?
- [ ] Have all cues, parentheticals, and metadata tags been stripped?
- [ ] Is the output directly usable in the teleprompter?
