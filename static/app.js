(() => {
  'use strict';

  // ---- Global state -------------------------------------------------------
  let audioStream = null;
  let videoStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let audioContext = null;
  let analyser = null;
  let isPrompting = false;
  let isRehearsal = false;

  // Transcript state
  let linesData = [];
  let allWords = [];
  let currentWordIndex = 0;
  let currentLineIndex = 0;

  // Server / engine state
  let ws = null;
  let wsConnected = false;
  let modelReady = false;
  let browserAudio = false;

  // Browser-audio streaming (--browser-audio fallback)
  let captureNode = null;

  // ---- DOM elements ---------------------------------------------------------
  const videoElem = document.getElementById('camera-feed');
  const transcriptInput = document.getElementById('transcript-input');
  const fileInput = document.getElementById('file-input');
  const btnAutoFormat = document.getElementById('btn-auto-format');
  const btnAutoFormatText = document.getElementById('btn-auto-format-text');
  const optAutoFormatOnPaste = document.getElementById('opt-auto-format-on-paste');
  const optPersistTranscript = document.getElementById('opt-persist-transcript');
  const btnClearTranscript = document.getElementById('btn-clear-transcript');
  const formatToast = document.getElementById('format-toast');
  const linesContainer = document.getElementById('lines-container');
  const scrollingContent = document.getElementById('scrolling-content');
  const prompterBox = document.getElementById('prompter-box');
  const btnRehearse = document.getElementById('btn-rehearse');
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnReset = document.getElementById('btn-reset');
  const vadStatus = document.getElementById('vad-status');
  const wsStatus = document.getElementById('ws-status');
  const speechHud = document.getElementById('speech-hud');
  const recIndicator = document.getElementById('rec-indicator');
  const vuBar = document.getElementById('vu-bar');
  const vuText = document.getElementById('vu-text');

  let autoFormatOnPaste = localStorage.getItem('teleprompter_auto_format_paste') !== 'false';
  if (optAutoFormatOnPaste) {
    optAutoFormatOnPaste.checked = autoFormatOnPaste;
    optAutoFormatOnPaste.addEventListener('change', (e) => {
      autoFormatOnPaste = e.target.checked;
      localStorage.setItem('teleprompter_auto_format_paste', String(autoFormatOnPaste));
    });
  }

  let persistTranscript = localStorage.getItem('teleprompter_persist_transcript') !== 'false';
  if (optPersistTranscript) {
    optPersistTranscript.checked = persistTranscript;
    optPersistTranscript.addEventListener('change', (e) => {
      persistTranscript = e.target.checked;
      localStorage.setItem('teleprompter_persist_transcript', String(persistTranscript));
      if (persistTranscript) {
        if (transcriptInput && transcriptInput.value) {
          localStorage.setItem('teleprompter_saved_transcript', transcriptInput.value);
        }
        showFormatToast('Persistence enabled ✓');
      } else {
        localStorage.removeItem('teleprompter_saved_transcript');
        showFormatToast('Persistence disabled');
      }
    });
  }

  function saveTranscriptIfEnabled() {
    if (persistTranscript) {
      if (transcriptInput && transcriptInput.value && transcriptInput.value.trim()) {
        localStorage.setItem('teleprompter_saved_transcript', transcriptInput.value);
      } else {
        localStorage.removeItem('teleprompter_saved_transcript');
      }
    }
    updateClearButtonVisibility();
  }

  function updateClearButtonVisibility() {
    if (!btnClearTranscript) return;
    if (transcriptInput && transcriptInput.value && transcriptInput.value.trim().length > 0) {
      btnClearTranscript.classList.remove('hidden');
    } else {
      btnClearTranscript.classList.add('hidden');
    }
  }

  if (btnClearTranscript) {
    btnClearTranscript.addEventListener('click', () => {
      if (!transcriptInput.value.trim()) return;
      if (transcriptInput.value.trim().length > 30) {
        if (!confirm('Are you sure you want to clear the transcript?')) return;
      }
      transcriptInput.value = '';
      if (persistTranscript) {
        localStorage.removeItem('teleprompter_saved_transcript');
      }
      updateClearButtonVisibility();
      parseAndRenderTranscript();
      updateStartButton();
      showFormatToast('Cleared ✓');
    });
  }

  window.addEventListener('beforeunload', () => {
    if (persistTranscript && transcriptInput && transcriptInput.value && transcriptInput.value.trim()) {
      localStorage.setItem('teleprompter_saved_transcript', transcriptInput.value);
    }
  });

  function showFormatToast(msg = 'Formatted ✓') {
    if (!formatToast) return;
    formatToast.textContent = msg;
    formatToast.classList.remove('opacity-0');
    formatToast.classList.add('opacity-100');
    setTimeout(() => {
      formatToast.classList.remove('opacity-100');
      formatToast.classList.add('opacity-0');
    }, 2000);
  }

  const optOpacity = document.getElementById('opt-opacity');
  const optFontsize = document.getElementById('opt-fontsize');
  const optSens = document.getElementById('opt-sens');
  const optMirror = document.getElementById('opt-mirror');
  const optLines = document.getElementById('opt-lines');
  const valLines = document.getElementById('val-lines');
  const viewingWindow = document.getElementById('viewing-window');
  const cursorBar = document.getElementById('cursor-bar');
  const optRecordMode = document.getElementById('opt-record-mode');
  const optRecordFormat = document.getElementById('opt-record-format');
  const recordingFormatGroup = document.getElementById('recording-format-group');
  const formatDesc = document.getElementById('format-desc');
  const optEngineSpeed = document.getElementById('opt-engine-speed');
  const engineBadge = document.getElementById('engine-badge');
  const engineDesc = document.getElementById('engine-desc');
  const optAudioSource = document.getElementById('opt-audio-source');
  const audioSourceBadge = document.getElementById('audio-source-badge');
  const audioSourceDesc = document.getElementById('audio-source-desc');
  let activeAudioSource = localStorage.getItem('teleprompter_audio_device') || 'browser';
  let availableAudioDevices = [];

  const ENGINE_DESCRIPTIONS = {
    ultrafast: '0.4s interval, tiny.en model (lowest latency, snappiest)',
    fast: '0.6s interval, base.en model (fast sync + accurate)',
    standard: '1.2s interval, base.en model (original server default)',
  };

  const ENGINE_LABELS = {
    ultrafast: 'Ultra Fast',
    fast: 'Fast',
    standard: 'Standard',
  };

  function updateEngineUI(mode) {
    if (engineBadge) {
      engineBadge.textContent = ENGINE_LABELS[mode] || mode;
    }
    if (engineDesc) {
      engineDesc.textContent = ENGINE_DESCRIPTIONS[mode] || '';
    }
    if (optEngineSpeed && optEngineSpeed.value !== mode) {
      optEngineSpeed.value = mode;
    }
  }

  if (optEngineSpeed) {
    const savedEngine = localStorage.getItem('teleprompter_engine_speed') || 'fast';
    optEngineSpeed.value = savedEngine;
    updateEngineUI(savedEngine);

    optEngineSpeed.addEventListener('change', (e) => {
      const mode = e.target.value;
      localStorage.setItem('teleprompter_engine_speed', mode);
      updateEngineUI(mode);
      send({ type: 'set_engine', mode: mode });
    });
  }

  // ---- Difficult Words State & Configuration -------------------------------
  let difficultWordsList = [];
  try {
    const savedWords = localStorage.getItem('teleprompter_difficult_words');
    if (savedWords) difficultWordsList = JSON.parse(savedWords);
  } catch (_) {
    difficultWordsList = [];
  }

  let difficultColor = localStorage.getItem('teleprompter_difficult_color') || '#f59e0b';
  let difficultStyle = localStorage.getItem('teleprompter_difficult_style') || 'pill';

  let difficultWordsSet = new Set(
    difficultWordsList.map((w) => w.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '')).filter(Boolean)
  );

  // ---- Rehearsal / Trial Fumbled Words State ------------------------------
  let rehearsalWordsList = [];
  try {
    const savedRehearsal = localStorage.getItem('teleprompter_rehearsal_words');
    if (savedRehearsal) rehearsalWordsList = JSON.parse(savedRehearsal);
  } catch (_) {
    rehearsalWordsList = [];
  }

  let rehearsalWordsSet = new Set(
    rehearsalWordsList.map((item) => (typeof item === 'string' ? item : item.clean || item.word).toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '')).filter(Boolean)
  );

  let rehearsalFilter = 'all'; // 'all' | 'skipped' | 'stumbled' | 'repeated'
  let syncPrompterWithFilter = false;
  try {
    syncPrompterWithFilter = localStorage.getItem('teleprompter_sync_fumble_filter') === 'true';
  } catch (_) {}

  function updateCuesCountBadge() {
    const countBadge = document.getElementById('difficult-count-badge');
    if (!countBadge) return;
    const diffCount = difficultWordsList.length;
    const rehCount = rehearsalWordsList.length;
    if (diffCount > 0 && rehCount > 0) {
      countBadge.textContent = `${diffCount} diff · ${rehCount} fumbled`;
    } else if (rehCount > 0) {
      countBadge.textContent = `${rehCount} ${rehCount === 1 ? 'fumble' : 'fumbles'}`;
    } else {
      countBadge.textContent = `${diffCount} ${diffCount === 1 ? 'word' : 'words'}`;
    }
  }

  function saveRehearsalWords() {
    rehearsalWordsSet = new Set(
      rehearsalWordsList.map((item) => (typeof item === 'string' ? item : item.clean || item.word).toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '')).filter(Boolean)
    );
    localStorage.setItem('teleprompter_rehearsal_words', JSON.stringify(rehearsalWordsList));
    updateCuesCountBadge();
  }

  function renderRehearsalTags() {
    const tagsList = document.getElementById('rehearsal-tags-list');
    const wordsCount = document.getElementById('rehearsal-words-count');
    if (wordsCount) wordsCount.textContent = String(rehearsalWordsList.length);
    updateCuesCountBadge();

    // Compute counts by tag type
    const counts = { all: rehearsalWordsList.length, skipped: 0, stumbled: 0, repeated: 0 };
    rehearsalWordsList.forEach((item) => {
      const r = (typeof item === 'object' && item.reason ? item.reason : 'stumbled').toLowerCase();
      if (counts[r] !== undefined) counts[r]++;
      else counts.stumbled++;
    });

    const countAll = document.getElementById('filter-count-all');
    const countSkipped = document.getElementById('filter-count-skipped');
    const countStumbled = document.getElementById('filter-count-stumbled');
    const countRepeated = document.getElementById('filter-count-repeated');
    if (countAll) countAll.textContent = String(counts.all);
    if (countSkipped) countSkipped.textContent = String(counts.skipped);
    if (countStumbled) countStumbled.textContent = String(counts.stumbled);
    if (countRepeated) countRepeated.textContent = String(counts.repeated);

    // Update active filter button state
    document.querySelectorAll('#rehearsal-filter-group .rehearsal-filter-btn').forEach((btn) => {
      if (btn.getAttribute('data-filter') === rehearsalFilter) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Update clear button text and state
    const btnClearRehearsalWords = document.getElementById('btn-clear-rehearsal-words');
    if (btnClearRehearsalWords) {
      if (rehearsalFilter === 'all') {
        btnClearRehearsalWords.textContent = 'Clear rehearsal fumbles';
        btnClearRehearsalWords.disabled = rehearsalWordsList.length === 0;
      } else {
        const matchCount = counts[rehearsalFilter] || 0;
        btnClearRehearsalWords.textContent = `Clear ${rehearsalFilter} (${matchCount})`;
        btnClearRehearsalWords.disabled = matchCount === 0;
      }
    }

    if (!tagsList) return;
    if (rehearsalWordsList.length === 0) {
      tagsList.innerHTML = '<span class="text-gray-500 italic text-[11px]">No trial fumbles detected yet. Run "Rehearse" to trial-test your script.</span>';
      return;
    }

    const indexedList = rehearsalWordsList.map((item, originalIdx) => ({ item, originalIdx }));
    const filtered = rehearsalFilter === 'all'
      ? indexedList
      : indexedList.filter(({ item }) => {
          const r = (typeof item === 'object' && item.reason ? item.reason : 'stumbled').toLowerCase();
          return r === rehearsalFilter;
        });

    if (filtered.length === 0) {
      tagsList.innerHTML = `<span class="text-gray-500 italic text-[11px]">No ${escapeHtml(rehearsalFilter)} fumbles found.</span>`;
      return;
    }

    tagsList.innerHTML = filtered.map(({ item, originalIdx }) => {
      const word = typeof item === 'string' ? item : (item.word || item.clean);
      const reason = typeof item === 'object' && item.reason ? item.reason : 'stumbled';
      const reasonLabel = reason === 'skipped' ? 'Skipped' : reason === 'repeated' ? 'Repeated' : 'Stumbled';
      const badgeClass = `rehearsal-badge rehearsal-badge-${reason === 'repeated' ? 'repeated' : reason === 'skipped' ? 'skipped' : 'stumbled'}`;
      return `
        <span class="rehearsal-tag-chip">
          <span>${escapeHtml(word)}</span>
          <span class="${badgeClass}">${reasonLabel}</span>
          <button type="button" class="keep-btn" data-idx="${originalIdx}" title="Keep permanently as difficult word">+ Keep</button>
          <button type="button" class="remove-btn" data-idx="${originalIdx}" title="Remove this specific fumble">×</button>
        </span>
      `;
    }).join('');
  }

  function hexToRgba(hex, alpha) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map((x) => x + x).join('');
    const num = parseInt(c, 16);
    if (isNaN(num)) return `rgba(245, 158, 11, ${alpha})`;
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function applyDifficultColorStyles() {
    document.documentElement.style.setProperty('--difficult-color', difficultColor);
    document.documentElement.style.setProperty('--difficult-bg', hexToRgba(difficultColor, 0.22));
    document.documentElement.style.setProperty('--difficult-border', hexToRgba(difficultColor, 0.55));

    const previewEl = document.getElementById('difficult-word-preview');
    if (previewEl) {
      previewEl.className = `prompter-word prompter-word-difficult style-${difficultStyle}`;
    }

    const swatches = document.querySelectorAll('.color-swatch');
    swatches.forEach((sw) => {
      const col = sw.getAttribute('data-color');
      if (col && col.toLowerCase() === difficultColor.toLowerCase()) {
        sw.classList.add('active-swatch');
      } else {
        sw.classList.remove('active-swatch');
      }
    });

    const picker = document.getElementById('picker-difficult-color');
    if (picker && picker.value.toLowerCase() !== difficultColor.toLowerCase()) {
      picker.value = difficultColor;
    }

    const radios = document.querySelectorAll('input[name="difficult-style"]');
    radios.forEach((r) => {
      if (r.value === difficultStyle) r.checked = true;
    });

    updateCuesCountBadge();
  }

  function saveDifficultWords() {
    difficultWordsSet = new Set(
      difficultWordsList.map((w) => w.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '')).filter(Boolean)
    );
    localStorage.setItem('teleprompter_difficult_words', JSON.stringify(difficultWordsList));
    localStorage.setItem('teleprompter_difficult_color', difficultColor);
    localStorage.setItem('teleprompter_difficult_style', difficultStyle);
    updateCuesCountBadge();
  }

  function showModalStatus(msg = 'Saved & Applied ✓') {
    const statusEl = document.getElementById('difficult-modal-status');
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.remove('opacity-0');
    statusEl.classList.add('opacity-100');
    setTimeout(() => {
      statusEl.classList.remove('opacity-100');
      statusEl.classList.add('opacity-0');
    }, 1800);
  }

  function renderDifficultTags() {
    const tagsList = document.getElementById('difficult-tags-list');
    const wordsCount = document.getElementById('difficult-words-count');
    if (wordsCount) wordsCount.textContent = String(difficultWordsList.length);
    updateCuesCountBadge();

    if (!tagsList) return;
    if (difficultWordsList.length === 0) {
      tagsList.innerHTML = '<span class="text-gray-500 italic text-[11px]">No difficult words added yet. Type a word above.</span>';
      return;
    }

    tagsList.innerHTML = difficultWordsList.map((word, idx) => `
      <span class="difficult-tag-chip">
        <span>${escapeHtml(word)}</span>
        <button type="button" class="remove-btn" data-idx="${idx}" title="Remove word">×</button>
      </span>
    `).join('');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function addDifficultWord(rawWord) {
    if (!rawWord || !rawWord.trim()) return;
    const parts = rawWord.split(/[,;\n\r\t]+/).map((s) => s.trim()).filter(Boolean);
    let added = false;
    for (const p of parts) {
      const cleaned = p.replace(/^[^\w]+|[^\w]+$/g, '');
      if (!cleaned) continue;
      const lower = cleaned.toLowerCase();
      if (!difficultWordsList.some((w) => w.toLowerCase() === lower)) {
        difficultWordsList.push(cleaned);
        added = true;
      }
    }
    if (added) {
      saveDifficultWords();
      renderDifficultTags();
      parseAndRenderTranscript();
      showModalStatus('Word added ✓');
    }
  }

  // Difficult Words Modal Elements & Events
  const modalDifficultWords = document.getElementById('modal-difficult-words');
  const btnOpenDifficultWords = document.getElementById('btn-open-difficult-words');
  const btnCloseDifficultWords = document.getElementById('btn-close-difficult-words');
  const btnSaveDifficultWords = document.getElementById('btn-save-difficult-words');
  const inputDifficultWord = document.getElementById('input-difficult-word');
  const btnAddDifficultWord = document.getElementById('btn-add-difficult-word');
  const btnClearDifficultWords = document.getElementById('btn-clear-difficult-words');
  const btnToggleBatchWords = document.getElementById('btn-toggle-batch-words');
  const batchWordsContainer = document.getElementById('batch-words-container');
  const textareaBatchWords = document.getElementById('textarea-batch-words');
  const btnImportBatchWords = document.getElementById('btn-import-batch-words');
  const pickerDifficultColor = document.getElementById('picker-difficult-color');
  const colorSwatchesContainer = document.getElementById('color-swatches-container');

  function openDifficultWordsModal() {
    if (!modalDifficultWords) return;
    renderDifficultTags();
    renderRehearsalTags();
    applyDifficultColorStyles();
    modalDifficultWords.classList.remove('hidden');
    if (inputDifficultWord) {
      setTimeout(() => inputDifficultWord.focus(), 50);
    }
  }

  function closeDifficultWordsModal() {
    if (!modalDifficultWords) return;
    modalDifficultWords.classList.add('hidden');
    if (batchWordsContainer) batchWordsContainer.classList.add('hidden');
    if (inputDifficultWord) inputDifficultWord.value = '';
    if (textareaBatchWords) textareaBatchWords.value = '';
  }

  if (btnOpenDifficultWords) {
    btnOpenDifficultWords.addEventListener('click', openDifficultWordsModal);
  }
  if (btnCloseDifficultWords) {
    btnCloseDifficultWords.addEventListener('click', closeDifficultWordsModal);
  }
  if (btnSaveDifficultWords) {
    btnSaveDifficultWords.addEventListener('click', () => {
      if (inputDifficultWord && inputDifficultWord.value.trim()) {
        addDifficultWord(inputDifficultWord.value.trim());
        inputDifficultWord.value = '';
      }
      closeDifficultWordsModal();
    });
  }

  if (modalDifficultWords) {
    modalDifficultWords.addEventListener('click', (e) => {
      if (e.target === modalDifficultWords) closeDifficultWordsModal();
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalDifficultWords && !modalDifficultWords.classList.contains('hidden')) {
      closeDifficultWordsModal();
    }
  });

  if (btnAddDifficultWord && inputDifficultWord) {
    btnAddDifficultWord.addEventListener('click', () => {
      addDifficultWord(inputDifficultWord.value.trim());
      inputDifficultWord.value = '';
      inputDifficultWord.focus();
    });
    inputDifficultWord.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addDifficultWord(inputDifficultWord.value.trim());
        inputDifficultWord.value = '';
      }
    });
  }

  if (btnToggleBatchWords && batchWordsContainer) {
    btnToggleBatchWords.addEventListener('click', () => {
      batchWordsContainer.classList.toggle('hidden');
      if (!batchWordsContainer.classList.contains('hidden') && textareaBatchWords) {
        textareaBatchWords.focus();
      }
    });
  }

  if (btnImportBatchWords && textareaBatchWords) {
    btnImportBatchWords.addEventListener('click', () => {
      addDifficultWord(textareaBatchWords.value);
      textareaBatchWords.value = '';
      batchWordsContainer.classList.add('hidden');
    });
  }

  if (btnClearDifficultWords) {
    btnClearDifficultWords.addEventListener('click', () => {
      if (difficultWordsList.length === 0) return;
      difficultWordsList = [];
      saveDifficultWords();
      renderDifficultTags();
      parseAndRenderTranscript();
      showModalStatus('Cleared all words');
    });
  }

  const btnClearRehearsalWords = document.getElementById('btn-clear-rehearsal-words');
  if (btnClearRehearsalWords) {
    btnClearRehearsalWords.addEventListener('click', () => {
      if (rehearsalWordsList.length === 0) return;
      if (rehearsalFilter === 'all') {
        rehearsalWordsList = [];
        showModalStatus('Cleared rehearsal fumbles ✓');
      } else {
        const initialCount = rehearsalWordsList.length;
        rehearsalWordsList = rehearsalWordsList.filter((item) => {
          const r = (typeof item === 'object' && item.reason ? item.reason : 'stumbled').toLowerCase();
          return r !== rehearsalFilter;
        });
        const removed = initialCount - rehearsalWordsList.length;
        if (removed === 0) return;
        showModalStatus(`Cleared ${removed} ${rehearsalFilter} fumble${removed === 1 ? '' : 's'} ✓`);
      }
      saveRehearsalWords();
      renderRehearsalTags();
      parseAndRenderTranscript();
    });
  }

  const rehearsalFilterGroup = document.getElementById('rehearsal-filter-group');
  if (rehearsalFilterGroup) {
    rehearsalFilterGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('.rehearsal-filter-btn');
      if (!btn) return;
      const filter = btn.getAttribute('data-filter');
      if (filter && filter !== rehearsalFilter) {
        rehearsalFilter = filter;
        renderRehearsalTags();
        if (syncPrompterWithFilter) {
          parseAndRenderTranscript();
        }
      }
    });
  }

  const checkboxFilterPrompter = document.getElementById('checkbox-filter-prompter');
  if (checkboxFilterPrompter) {
    checkboxFilterPrompter.checked = syncPrompterWithFilter;
    checkboxFilterPrompter.addEventListener('change', (e) => {
      syncPrompterWithFilter = e.target.checked;
      try {
        localStorage.setItem('teleprompter_sync_fumble_filter', String(syncPrompterWithFilter));
      } catch (_) {}
      parseAndRenderTranscript();
    });
  }

  const difficultTagsList = document.getElementById('difficult-tags-list');
  if (difficultTagsList) {
    difficultTagsList.addEventListener('click', (e) => {
      const btn = e.target.closest('.remove-btn');
      if (!btn) return;
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      if (!isNaN(idx) && idx >= 0 && idx < difficultWordsList.length) {
        difficultWordsList.splice(idx, 1);
        saveDifficultWords();
        renderDifficultTags();
        parseAndRenderTranscript();
      }
    });
  }

  const rehearsalTagsList = document.getElementById('rehearsal-tags-list');
  if (rehearsalTagsList) {
    rehearsalTagsList.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.remove-btn');
      if (removeBtn) {
        const idx = parseInt(removeBtn.getAttribute('data-idx'), 10);
        if (!isNaN(idx) && idx >= 0 && idx < rehearsalWordsList.length) {
          rehearsalWordsList.splice(idx, 1);
          saveRehearsalWords();
          renderRehearsalTags();
          parseAndRenderTranscript();
          showModalStatus('Fumbled word removed ✓');
        }
        return;
      }
      const keepBtn = e.target.closest('.keep-btn');
      if (keepBtn) {
        const idx = parseInt(keepBtn.getAttribute('data-idx'), 10);
        if (!isNaN(idx) && idx >= 0 && idx < rehearsalWordsList.length) {
          const item = rehearsalWordsList[idx];
          const word = typeof item === 'string' ? item : (item.word || item.clean);
          addDifficultWord(word);
          rehearsalWordsList.splice(idx, 1);
          saveRehearsalWords();
          renderRehearsalTags();
          showModalStatus('Saved to Configured Difficult Words ✓');
        }
      }
    });
  }

  if (colorSwatchesContainer) {
    colorSwatchesContainer.addEventListener('click', (e) => {
      const swatch = e.target.closest('.color-swatch');
      if (!swatch) return;
      const col = swatch.getAttribute('data-color');
      if (col) {
        difficultColor = col;
        saveDifficultWords();
        applyDifficultColorStyles();
        parseAndRenderTranscript();
        showModalStatus('Color updated ✓');
      }
    });
  }

  if (pickerDifficultColor) {
    pickerDifficultColor.addEventListener('input', (e) => {
      difficultColor = e.target.value;
      saveDifficultWords();
      applyDifficultColorStyles();
      parseAndRenderTranscript();
    });
  }

  document.querySelectorAll('input[name="difficult-style"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      difficultStyle = e.target.value;
      saveDifficultWords();
      applyDifficultColorStyles();
      parseAndRenderTranscript();
      showModalStatus('Style updated ✓');
    });
  });

  // ---- Audio Source Selection (Browser WebRTC vs Hardware Mic) -------------
  function updateAudioSourceUI(deviceId, devicesList) {
    if (devicesList && devicesList.length) {
      availableAudioDevices = devicesList;
      if (optAudioSource) {
        optAudioSource.innerHTML = '';
        devicesList.forEach((d) => {
          const opt = document.createElement('option');
          opt.value = d.id;
          opt.textContent = d.name;
          if (String(d.id) === String(deviceId)) opt.selected = true;
          optAudioSource.appendChild(opt);
        });
      }
    }
    activeAudioSource = String(deviceId);
    if (optAudioSource) {
      optAudioSource.value = activeAudioSource;
    }
    const isBrowser = activeAudioSource === 'browser';
    if (audioSourceBadge) {
      audioSourceBadge.textContent = isBrowser ? 'Browser Mic' : 'Hardware Mic';
      audioSourceBadge.className = 'text-[10px] px-1.5 py-0.5 rounded font-mono border ' +
        (isBrowser ? 'bg-green-950 text-green-300 border-green-700/50' : 'bg-indigo-950 text-indigo-300 border-indigo-700/50');
    }
    if (audioSourceDesc) {
      audioSourceDesc.textContent = isBrowser
        ? 'Streams directly from your active browser tab mic (matches VU meter).'
        : 'Backend captures directly from host hardware sound device.';
    }
  }

  if (optAudioSource) {
    optAudioSource.addEventListener('change', (e) => {
      const devId = e.target.value;
      activeAudioSource = devId;
      localStorage.setItem('teleprompter_audio_device', devId);
      updateAudioSourceUI(devId);
      send({ type: 'set_audio_device', device: devId });
      if (devId === 'browser') {
        if (isPrompting) startBrowserAudioStream();
      } else {
        stopBrowserAudioStream();
      }
    });
  }

  // ---- Audio & Video Format Configuration ----------------------------------
  const VIDEO_FORMATS = [
    { id: 'mp4', label: 'MP4 (.mp4)', desc: 'Universal MP4 video format (H.264/AAC)' },
    { id: 'webm', label: 'WebM (.webm)', desc: 'High-efficiency WebM video format (VP9/Opus)' },
  ];

  const AUDIO_FORMATS = [
    { id: 'mp3', label: 'MP3 (.mp3)', desc: 'Universal compressed MP3 audio (192 kbps)' },
    { id: 'wav', label: 'WAV (.wav)', desc: 'Lossless 16-bit PCM WAV (studio quality, uncompressed)' },
    { id: 'webm', label: 'WebM (.webm)', desc: 'WebM Opus compressed audio' },
  ];

  let activeRecordMode = localStorage.getItem('teleprompter_record_mode') || 'video';
  if (optRecordMode) optRecordMode.value = activeRecordMode;

  let activeVideoFormat = localStorage.getItem('teleprompter_video_format') || 'mp4';
  let activeAudioFormat = localStorage.getItem('teleprompter_audio_format') || 'mp3';
  let activeRecordingOptions = { mimeType: '', extension: 'webm', format: 'webm' };

  function updateFormatUI() {
    const mode = optRecordMode ? optRecordMode.value : 'video';
    activeRecordMode = mode;
    localStorage.setItem('teleprompter_record_mode', mode);

    if (mode === 'off') {
      if (recordingFormatGroup) recordingFormatGroup.classList.add('hidden');
    } else {
      if (recordingFormatGroup) recordingFormatGroup.classList.remove('hidden');
      if (optRecordFormat) {
        optRecordFormat.innerHTML = '';
        const formats = mode === 'video' ? VIDEO_FORMATS : AUDIO_FORMATS;
        const currentSelected = mode === 'video' ? activeVideoFormat : activeAudioFormat;
        formats.forEach((f) => {
          const opt = document.createElement('option');
          opt.value = f.id;
          opt.textContent = f.label;
          if (f.id === currentSelected) opt.selected = true;
          optRecordFormat.appendChild(opt);
        });
        const chosen = formats.find((f) => f.id === optRecordFormat.value) || formats[0];
        if (formatDesc) formatDesc.textContent = chosen ? chosen.desc : '';
      }
    }
    updateStopButtonText();
  }

  if (optRecordMode) {
    optRecordMode.addEventListener('change', updateFormatUI);
  }

  if (optRecordFormat) {
    optRecordFormat.addEventListener('change', (e) => {
      const mode = optRecordMode ? optRecordMode.value : 'video';
      if (mode === 'video') {
        activeVideoFormat = e.target.value;
        localStorage.setItem('teleprompter_video_format', activeVideoFormat);
      } else {
        activeAudioFormat = e.target.value;
        localStorage.setItem('teleprompter_audio_format', activeAudioFormat);
      }
      const formats = mode === 'video' ? VIDEO_FORMATS : AUDIO_FORMATS;
      const chosen = formats.find((f) => f.id === e.target.value);
      if (formatDesc && chosen) formatDesc.textContent = chosen.desc;
      updateStopButtonText();
    });
  }

  // ---- Audio Encoders (WAV & MP3) ------------------------------------------
  function audioBufferToWav(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const length = audioBuffer.length;
    const byteRate = sampleRate * blockAlign;
    const dataSize = length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channelData.push(audioBuffer.getChannelData(ch));
    }

    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channelData[ch][i];
        sample = Math.max(-1, Math.min(1, sample));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, intSample, true);
        offset += 2;
      }
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  function audioBufferToMp3(audioBuffer, kbps = 192) {
    if (typeof lamejs === 'undefined') {
      throw new Error('MP3 encoder not available.');
    }
    const channels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
    const mp3Data = [];
    const sampleBlockSize = 1152;

    function floatToInt16(floatArr) {
      const int16 = new Int16Array(floatArr.length);
      for (let i = 0; i < floatArr.length; i++) {
        const s = Math.max(-1, Math.min(1, floatArr[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      return int16;
    }

    if (channels === 1) {
      const samples = floatToInt16(audioBuffer.getChannelData(0));
      for (let i = 0; i < samples.length; i += sampleBlockSize) {
        const chunk = samples.subarray(i, i + sampleBlockSize);
        const mp3buf = mp3encoder.encodeBuffer(chunk);
        if (mp3buf.length > 0) mp3Data.push(mp3buf);
      }
    } else {
      const left = floatToInt16(audioBuffer.getChannelData(0));
      const right = floatToInt16(audioBuffer.getChannelData(1));
      for (let i = 0; i < left.length; i += sampleBlockSize) {
        const leftChunk = left.subarray(i, i + sampleBlockSize);
        const rightChunk = right.subarray(i, i + sampleBlockSize);
        const mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
        if (mp3buf.length > 0) mp3Data.push(mp3buf);
      }
    }

    const endBuf = mp3encoder.flush();
    if (endBuf.length > 0) mp3Data.push(endBuf);

    return new Blob(mp3Data, { type: 'audio/mp3' });
  }

  function getAudioRecorderOptions(targetFormat) {
    const mimeTypes = [
      { mime: 'audio/webm;codecs=opus', ext: 'webm' },
      { mime: 'audio/webm', ext: 'webm' },
      { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
      { mime: 'audio/mp4', ext: 'm4a' },
      { mime: 'audio/aac', ext: 'm4a' }
    ];
    let matchedMime = '';
    if (window.MediaRecorder && typeof MediaRecorder.isTypeSupported === 'function') {
      for (const item of mimeTypes) {
        if (MediaRecorder.isTypeSupported(item.mime)) {
          matchedMime = item.mime;
          break;
        }
      }
    }
    const ext = targetFormat === 'wav' ? 'wav' : (targetFormat === 'mp3' ? 'mp3' : 'webm');
    return { mimeType: matchedMime, extension: ext, format: targetFormat };
  }

  function getVideoRecorderOptions(targetFormat) {
    if (targetFormat === 'mp4') {
      const mp4Mimes = [
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4;codecs=avc1,opus',
        'video/mp4;codecs=avc1',
        'video/mp4;codecs=h264,aac',
        'video/mp4;codecs=h264',
        'video/mp4'
      ];
      if (window.MediaRecorder && typeof MediaRecorder.isTypeSupported === 'function') {
        for (const mime of mp4Mimes) {
          if (MediaRecorder.isTypeSupported(mime)) {
            return { mimeType: mime, extension: 'mp4', format: 'mp4' };
          }
        }
      }
    }

    const webmMimes = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    if (window.MediaRecorder && typeof MediaRecorder.isTypeSupported === 'function') {
      for (const mime of webmMimes) {
        if (MediaRecorder.isTypeSupported(mime)) {
          return { mimeType: mime, extension: 'webm', format: 'webm' };
        }
      }
    }
    return { mimeType: '', extension: 'webm', format: 'webm' };
  }

  function updateStopButtonText() {
    if (isRehearsal) {
      btnStop.textContent = 'Finish Rehearsal';
      btnStop.className = 'px-4 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold rounded shadow transition cursor-pointer';
      return;
    }
    btnStop.className = 'px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-semibold rounded shadow transition cursor-pointer';
    const mode = optRecordMode ? optRecordMode.value : 'video';
    if (mode === 'audio') {
      const fmt = (activeAudioFormat || 'mp3').toUpperCase();
      btnStop.textContent = `Stop & Save Audio (${fmt})`;
    } else if (mode === 'video') {
      const fmt = (activeVideoFormat || 'mp4').toUpperCase();
      btnStop.textContent = `Stop & Save Video (${fmt})`;
    } else {
      btnStop.textContent = 'Stop Session';
    }
  }

  // ---- WebSocket -----------------------------------------------------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      wsConnected = true;
      wsStatus.textContent = 'connected';
      wsStatus.className = 'text-[10px] px-2 py-0.5 rounded bg-green-950 text-green-400 font-mono border border-green-500/30';
      const savedEngine = localStorage.getItem('teleprompter_engine_speed');
      if (savedEngine) {
        send({ type: 'set_engine', mode: savedEngine });
      }
      updateStartButton();
    };
    ws.onclose = () => {
      wsConnected = false;
      updateStartButton();
      setBadge(wsStatus, 'reconnecting…', 'bg-yellow-950 text-yellow-400 border-yellow-500/30');
      setTimeout(connect, 1500);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleMessage(msg);
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'config':
        browserAudio = !!msg.browser_audio;
        if (msg.profile) {
          const saved = localStorage.getItem('teleprompter_engine_speed');
          if (!saved) updateEngineUI(msg.profile);
        }
        if (msg.audio_devices) {
          const savedDev = localStorage.getItem('teleprompter_audio_device');
          const activeDev = savedDev || msg.active_audio_device || 'browser';
          updateAudioSourceUI(activeDev, msg.audio_devices);
          if (savedDev && String(savedDev) !== String(msg.active_audio_device)) {
            send({ type: 'set_audio_device', device: savedDev });
          }
        }
        if (activeAudioSource === 'browser' && isPrompting && audioContext && audioContext.state === 'running') {
          startBrowserAudioStream();
        }
        break;
      case 'audio_device_changed':
        updateAudioSourceUI(msg.device);
        break;
      case 'status':
        onStatus(msg);
        break;
      case 'sync':
        onSync(msg);
        break;
      case 'fumble':
        onFumble(msg);
        break;
      case 'rehearsal_summary':
        onRehearsalSummary(msg);
        break;
      case 'error':
        speechHud.textContent = '⚠ ' + msg.message;
        setBadge(vadStatus, 'ERROR', 'bg-red-950 text-red-400 border-red-500/30');
        break;
      default:
        break;
    }
  }

  function onFumble(msg) {
    const incoming = Array.isArray(msg.fumbles) ? msg.fumbles : (msg.fumble ? [msg.fumble] : []);
    let added = false;
    incoming.forEach((f) => {
      if (!f || !f.clean) return;
      const clean = f.clean.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
      if (!clean) return;
      if (!rehearsalWordsSet.has(clean)) {
        rehearsalWordsList.push({
          word: f.word || clean,
          clean: clean,
          reason: f.reason || 'stumbled',
        });
        rehearsalWordsSet.add(clean);
        added = true;
      }
      const wordEl = document.getElementById(`w-${f.index}`);
      if (wordEl) {
        const reason = f.reason || 'stumbled';
        wordEl.classList.add('prompter-word-difficult', `style-${difficultStyle}`, 'prompter-word-rehearsal', `prompter-word-rehearsal-${reason}`);
      }
    });

    if (added) {
      saveRehearsalWords();
      renderRehearsalTags();
    }
  }

  function onRehearsalSummary(msg) {
    if (msg.fumbles && Array.isArray(msg.fumbles)) {
      onFumble(msg);
    }
  }

  function onStatus(msg) {
    if (msg.profile) {
      updateEngineUI(msg.profile);
    }
    if (msg.active_audio_device && !availableAudioDevices.length) {
      updateAudioSourceUI(msg.active_audio_device);
    }
    if (msg.mic_warning === true) {
      setBadge(vadStatus, 'MIC SILENT', 'bg-red-950 text-red-400 border-red-500/30 animate-pulse');
      speechHud.textContent = '⚠️ ' + (msg.message || 'Selected microphone is silent. Try Browser Microphone in Options.');
    } else if (msg.mic_warning === false && isPrompting) {
      setBadge(vadStatus, 'SYNCING – VOICE DETECTED', 'bg-green-950 text-green-400 border-green-500/30');
      speechHud.textContent = 'Voice detected → advancing transcript…';
    }
    if (typeof msg.ready === 'boolean') {
      modelReady = msg.ready;
      if (modelReady) {
        const modelLabel = msg.model ? ` [${msg.model}]` : '';
        setBadge(vadStatus, `OFFLINE ENGINE READY${modelLabel}`, 'bg-green-950 text-green-400 border-green-500/30');
        speechHud.textContent = 'Local Whisper ready. Paste a script and Start.';
      } else {
        const modelLabel = msg.model ? ` (${msg.model})` : '';
        setBadge(vadStatus, `LOADING MODEL${modelLabel}…`, 'bg-indigo-950 text-indigo-400 border-indigo-500/30');
        speechHud.textContent = `Downloading / initializing local model${modelLabel}…`;
      }
    }
    if (msg.running === false && !isPrompting) {
      speechHud.textContent = 'Session ended – recording saved.';
    }
    updateStartButton();
  }

  function onSync(msg) {
    if (!isPrompting) return;
    const idx = Number(msg.word_index);
    if (Number.isFinite(idx) && idx >= 0 && idx < allWords.length) {
      updateHighlighting(idx);
    }
    if (msg.state === 'speaking') {
      setBadge(vadStatus, 'SYNCING – VOICE DETECTED', 'bg-green-950 text-green-400 border-green-500/30');
      speechHud.textContent = 'Voice detected → advancing transcript…';
    }
  }

  function setBadge(el, text, cls) {
    el.textContent = text;
    el.className = 'text-xs px-2.5 py-0.5 rounded font-mono border ' + cls;
  }
  function setWsBadge(el, text, cls) {
    el.textContent = text;
    el.className = 'text-[10px] px-2 py-0.5 rounded font-mono border ' + cls;
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // ---- Update start button (disabled until ready) --------------------------
  function updateStartButton() {
    const ready = wsConnected && modelReady;
    const canRun = ready && !isPrompting && allWords.length > 0;
    btnStart.disabled = !canRun;
    if (btnRehearse) btnRehearse.disabled = !canRun;
    if (!modelReady && wsConnected) {
      btnStart.disabled = true;
      if (btnRehearse) btnRehearse.disabled = true;
    }
  }

  // ---- Audio initialization & local VU analyser ----------------------------
  async function initAudio() {
    if (audioStream) return;
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(audioStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      function processLocalAudio() {
        if (analyser && isPrompting) {
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 2; i < 30; i++) sum += dataArray[i];
          const average = sum / 28;
          const levelPercent = Math.min(100, Math.round((average / 128) * 100));
          vuBar.style.width = levelPercent + '%';
          vuText.textContent = levelPercent + '%';

          const threshold = parseInt(optSens.value, 10);
          if (levelPercent > threshold) {
            if (!vuBar.dataset.speaking) {
              vuBar.dataset.speaking = '1';
              setBadge(vadStatus, 'VOICE DETECTED (local)', 'bg-green-950 text-green-400 border-green-500/30');
            }
          } else {
            if (vuBar.dataset.speaking) {
              delete vuBar.dataset.speaking;
              if (isPrompting) setBadge(vadStatus, 'HOLDING – SILENCE', 'bg-yellow-950 text-yellow-400 border-yellow-500/30');
            }
          }
        }
        requestAnimationFrame(processLocalAudio);
      }
      processLocalAudio();

      if (browserAudio && audioContext.state === 'running') startBrowserAudioStream();
    } catch (err) {
      alert('Microphone access error: ' + err.message);
    }
  }

  // ---- Camera controls & stream lifecycle -----------------------------------
  async function startCamera() {
    try {
      stopCamera();
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      videoElem.srcObject = videoStream;
      videoElem.classList.remove('hidden');
    } catch (err) {
      alert('Camera access error: ' + err.message);
    }
  }

  function stopCamera() {
    if (videoStream) {
      videoStream.getTracks().forEach((t) => t.stop());
      videoStream = null;
    }
    if (videoElem.srcObject) {
      videoElem.srcObject = null;
    }
    videoElem.classList.add('hidden');
  }

  async function initCameraAndAudio() {
    await initAudio();
    const cameraToggle = document.getElementById('opt-camera-toggle');
    if (cameraToggle && cameraToggle.checked) {
      await startCamera();
    } else {
      stopCamera();
    }
  }

  // ---- Browser-audio streaming (WebRTC audio to WebSocket) ------------------
  function startBrowserAudioStream() {
    if (captureNode || !audioContext || !audioStream) return;
    if (activeAudioSource !== 'browser') return;
    try {
      const source = audioContext.createMediaStreamSource(audioStream);
      captureNode = audioContext.createScriptProcessor(4096, 1, 1);
      const silent = audioContext.createGain();
      silent.gain.value = 0;
      source.connect(captureNode);
      captureNode.connect(silent);
      silent.connect(audioContext.destination);

      captureNode.onaudioprocess = (e) => {
        if (!isPrompting || !ws || ws.readyState !== WebSocket.OPEN) return;
        if (activeAudioSource !== 'browser') return;
        const raw = e.inputBuffer.getChannelData(0);
        const ratio = audioContext.sampleRate / 16000;
        const outLen = Math.floor(raw.length / ratio);
        if (outLen < 1) return;
        const out = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const srcPos = i * ratio;
          const idx0 = Math.floor(srcPos);
          const idx1 = Math.min(raw.length - 1, idx0 + 1);
          const frac = srcPos - idx0;
          out[i] = raw[idx0] * (1 - frac) + raw[idx1] * frac;
        }
        send({ type: 'audio', data: Array.from(out) });
      };
    } catch (err) {
      console.error('Error initializing browser audio stream:', err);
    }
  }

  function stopBrowserAudioStream() {
    if (captureNode) {
      try {
        captureNode.disconnect();
      } catch (_) { }
      captureNode = null;
    }
  }

  // ---- Camera controls --------------------------------------------------------
  document.getElementById('opt-camera-toggle').addEventListener('change', async (e) => {
    if (e.target.checked) {
      await startCamera();
    } else {
      stopCamera();
    }
  });

  document.getElementById('opt-zoom').addEventListener('input', (e) => {
    const zoom = parseFloat(e.target.value);
    document.getElementById('val-zoom').textContent = zoom.toFixed(1) + 'x';
    videoElem.style.transform = `scale(${zoom})`;
  });
  optOpacity.addEventListener('input', (e) => {
    prompterBox.style.backgroundColor = `rgba(17, 24, 39, ${e.target.value})`;
    document.getElementById('val-opacity').textContent = `${Math.round(e.target.value * 100)}%`;
  });

  optFontsize.addEventListener('input', (e) => {
    linesContainer.style.fontSize = `${e.target.value}px`;
    document.getElementById('val-fontsize').textContent = `${e.target.value}px`;
  });

  optMirror.addEventListener('change', (e) => {
    prompterBox.classList.toggle('mirrored', e.target.checked);
  });

  optSens.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    let label = 'Medium';
    if (val < 10) label = 'High (Quiet Voice)';
    else if (val > 20) label = 'Low (Loud Mic)';
    document.getElementById('val-sens').textContent = label;
  });

  optLines.addEventListener('input', (e) => {
    const numLines = parseInt(e.target.value, 10);
    valLines.textContent = numLines;
    updateViewportLines(numLines);
  });

  function updateViewportLines(numLines) {
    const activeLineOffset = 1; // Exactly 1 line above the active line (2nd line)
    const lineH = 45;
    viewingWindow.style.height = (numLines * lineH) + 'px';
    cursorBar.style.top = (activeLineOffset * lineH) + 'px';
    cursorBar.style.height = lineH + 'px';
    scrollingContent.style.paddingTop = (activeLineOffset * lineH) + 'px';
  }

  // ---- Automatic Teleprompter Script Phrasing & Formatting -----------------
  function formatScriptForPrompter(text) {
    if (!text || !text.trim()) return '';

    const PREPOSITIONS = new Set([
      'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'of', 'into',
      'through', 'across', 'about', 'as', 'over', 'under', 'between'
    ]);

    const CONJUNCTIONS = new Set(['and', 'or', 'but', 'nor', 'so', 'yet']);

    const COMMON_VERBS = new Set([
      'combines', 'combine', 'features', 'feature', 'delivers', 'deliver',
      'includes', 'include', 'provides', 'provide', 'supports', 'support',
      'offers', 'offer', 'enables', 'enable', 'allows', 'allow', 'ensures',
      'ensure', 'uses', 'use', 'improves', 'improve', 'contains', 'contain',
      'requires', 'require', 'creates', 'create', 'works', 'work'
    ]);

    const ARTICLES_AND_PRONOUNS = new Set([
      'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his',
      'her', 'its', 'our', 'their', 'which', 'who', 'whom', 'whose', 'it', 'we',
      'you', 'they', 'he', 'she'
    ]);

    // Key compound technical terms and noun phrases that must remain intact
    const PROTECTED_TERMS = [
      'variable geometry turbochargers',
      'proven flow measurement technology',
      'flow measurement technology',
      'passenger car and light commercial vehicle applications',
      'light commercial vehicle applications',
      'light commercial vehicles',
      'enhanced actuator control',
      'actuator control',
      'aftermarket repair',
      'Turbo Technics VTR100 EVO',
      'VTR100 EVO'
    ];

    // Clean raw paragraphs (preserve deliberate empty lines)
    const rawParagraphs = text.split(/\r?\n\s*\r?\n/);
    const formattedSections = [];

    for (const para of rawParagraphs) {
      const trimmedPara = para.trim();
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
        const sentenceLines = formatSentence(sentence);

        if (paraOutputLines.length > 0 && sentenceLines.length > 0) {
          // Breath pause line between distinct sentences
          paraOutputLines.push('');
        }

        paraOutputLines.push(...sentenceLines);
      }

      formattedSections.push(paraOutputLines.join('\n'));
    }

    return formattedSections.join('\n\n');

    function formatSentence(sentence) {
      const rawWords = sentence.split(/\s+/).filter(Boolean);
      if (rawWords.length <= 8) {
        return [rawWords.join(' ')];
      }

      // Step 1: Tokenize & identify protected noun phrases / technical terms
      const units = [];
      let i = 0;

      while (i < rawWords.length) {
        // 1. Check known multi-word protected terms
        let matchedPhrase = null;
        for (const phrase of PROTECTED_TERMS) {
          const pWords = phrase.split(' ');
          if (i + pWords.length <= rawWords.length) {
            let matches = true;
            for (let p = 0; p < pWords.length; p++) {
              const wClean = rawWords[i + p].toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
              if (wClean !== pWords[p].toLowerCase()) {
                matches = false;
                break;
              }
            }
            if (matches) {
              if (!matchedPhrase || pWords.length > matchedPhrase.length) {
                matchedPhrase = pWords;
              }
            }
          }
        }

        if (matchedPhrase) {
          const slice = rawWords.slice(i, i + matchedPhrase.length);
          const last = slice[slice.length - 1];
          units.push({
            text: slice.join(' '),
            words: slice,
            wordCount: slice.length,
            isProtected: true,
            forceOwnLine: slice.length >= 3,
            hasComma: last.endsWith(',') || last.endsWith(';') || last.endsWith(':')
          });
          i += matchedPhrase.length;
          continue;
        }

        // 2. Dynamic compound noun / technical phrase identification (2-4 content words)
        const w = rawWords[i];
        const cleanW = w.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
        const isFuncOrVerb = PREPOSITIONS.has(cleanW) || CONJUNCTIONS.has(cleanW) ||
          ARTICLES_AND_PRONOUNS.has(cleanW) || COMMON_VERBS.has(cleanW);

        if (!isFuncOrVerb && !w.endsWith(',') && !w.endsWith(';') && i + 1 < rawWords.length) {
          const nextW = rawWords[i + 1];
          const nextClean = nextW.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
          const nextIsFuncOrVerb = PREPOSITIONS.has(nextClean) || CONJUNCTIONS.has(nextClean) ||
            ARTICLES_AND_PRONOUNS.has(nextClean) || COMMON_VERBS.has(nextClean);

          if (!nextIsFuncOrVerb) {
            const compSlice = [w, nextW];
            let k = i + 2;
            while (k < rawWords.length && (k - i) < 4) {
              const extraW = rawWords[k];
              const extraClean = extraW.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
              if (PREPOSITIONS.has(extraClean) || CONJUNCTIONS.has(extraClean) ||
                ARTICLES_AND_PRONOUNS.has(extraClean) || COMMON_VERBS.has(extraClean)) break;
              compSlice.push(extraW);
              k++;
              if (extraW.endsWith(',') || extraW.endsWith(';')) break;
            }

            const last = compSlice[compSlice.length - 1];
            units.push({
              text: compSlice.join(' '),
              words: compSlice,
              wordCount: compSlice.length,
              isProtected: true,
              forceOwnLine: compSlice.length >= 3,
              hasComma: last.endsWith(',') || last.endsWith(';') || last.endsWith(':')
            });
            i = k;
            continue;
          }
        }

        // Single word unit
        units.push({
          text: w,
          words: [w],
          wordCount: 1,
          isProtected: false,
          forceOwnLine: false,
          hasComma: w.endsWith(',') || w.endsWith(';') || w.endsWith(':')
        });
        i++;
      }

      // Step 2: Build rhythmic lines (target 5-8 words max)
      const lines = [];
      let currentWords = [];
      let wordsSinceBreath = 0;

      function flushCurrentLine(addBreath = false) {
        if (currentWords.length === 0) return;
        lines.push(currentWords.join(' '));
        wordsSinceBreath += currentWords.length;
        if (addBreath && wordsSinceBreath >= 8) {
          lines.push(''); // Breath pause line
          wordsSinceBreath = 0;
        }
        currentWords = [];
      }

      for (let u = 0; u < units.length; u++) {
        const unit = units[u];
        const unitFirstClean = unit.words[0].toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
        const isPrepOrConj = PREPOSITIONS.has(unitFirstClean) || CONJUNCTIONS.has(unitFirstClean);

        const wouldExceed = (currentWords.length + unit.wordCount) > 8;

        const shouldBreakBefore = currentWords.length > 0 && (
          wouldExceed ||
          unit.forceOwnLine ||
          (currentWords.length >= 4 && isPrepOrConj)
        );

        if (shouldBreakBefore) {
          flushCurrentLine(false);
        }

        currentWords.push(...unit.words);

        if (unit.hasComma) {
          const isMajorClause = currentWords.length >= 7 || wordsSinceBreath >= 12;
          flushCurrentLine(isMajorClause);
        } else if (currentWords.length >= 8 || unit.forceOwnLine) {
          flushCurrentLine(false);
        }
      }

      flushCurrentLine(false);

      // Step 3: Polish lines
      // 1) Forward-merge short lead-in lines (<= 2 words starting with preposition/article/conjunction)
      const forwardMerged = [];
      for (let l = 0; l < lines.length; l++) {
        const line = lines[l];
        if (line === '') {
          forwardMerged.push('');
          continue;
        }
        const lWords = line.split(/\s+/).filter(Boolean);
        const firstClean = lWords[0].toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
        const isLeadIn = PREPOSITIONS.has(firstClean) || CONJUNCTIONS.has(firstClean) || ARTICLES_AND_PRONOUNS.has(firstClean);

        if (lWords.length <= 2 && isLeadIn && l < lines.length - 1 && lines[l + 1] !== '') {
          const nextWords = lines[l + 1].split(/\s+/).filter(Boolean);
          if (lWords.length + nextWords.length <= 8) {
            lines[l + 1] = `${line} ${lines[l + 1]}`;
            continue;
          }
        }
        forwardMerged.push(line);
      }

      // 2) Backward-merge short trailing fragments if appropriate
      const result = [];
      for (let l = 0; l < forwardMerged.length; l++) {
        const line = forwardMerged[l];
        if (line === '') {
          result.push('');
          continue;
        }
        const lWords = line.split(/\s+/).filter(Boolean);
        if (lWords.length <= 2 && result.length > 0) {
          const prev = result[result.length - 1];
          if (prev !== '') {
            const prevWords = prev.split(/\s+/).filter(Boolean);
            if (prevWords.length + lWords.length <= 8) {
              result[result.length - 1] = `${prev} ${line}`;
              continue;
            }
          }
        }
        result.push(line);
      }

      return result;
    }
  }

  // ---- Auto-Format button & Paste handling -----------------------------------
  if (btnAutoFormat) {
    btnAutoFormat.addEventListener('click', () => {
      if (!transcriptInput.value || !transcriptInput.value.trim()) return;
      const formatted = formatScriptForPrompter(transcriptInput.value);
      transcriptInput.value = formatted;
      saveTranscriptIfEnabled();
      parseAndRenderTranscript();
      updateStartButton();
      showFormatToast('Formatted ✓');
    });
  }

  transcriptInput.addEventListener('paste', () => {
    if (!autoFormatOnPaste) {
      setTimeout(() => {
        saveTranscriptIfEnabled();
      }, 0);
      return;
    }
    setTimeout(() => {
      if (!transcriptInput.value.trim()) return;
      const formatted = formatScriptForPrompter(transcriptInput.value);
      transcriptInput.value = formatted;
      saveTranscriptIfEnabled();
      parseAndRenderTranscript();
      updateStartButton();
      showFormatToast('Auto-formatted ✓');
    }, 50);
  });

  // ---- File upload ----------------------------------------------------------
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    try {
      let rawText = '';
      if (name.endsWith('.txt') || name.endsWith('.md')) {
        rawText = await file.text();
      } else if (name.endsWith('.docx')) {
        const buffer = await file.arrayBuffer();
        const res = await mammoth.extractRawText({ arrayBuffer: buffer });
        rawText = res.value;
      } else if (name.endsWith('.pdf')) {
        const buffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        let text = '';
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map((it) => it.str).join(' ') + '\n';
        }
        rawText = text;
      } else {
        return;
      }

      if (autoFormatOnPaste) {
        transcriptInput.value = formatScriptForPrompter(rawText);
        showFormatToast('Auto-formatted file ✓');
      } else {
        transcriptInput.value = rawText;
      }
      saveTranscriptIfEnabled();
      parseAndRenderTranscript();
      updateStartButton();
    } catch (err) {
      alert('Could not read file: ' + err.message);
    }
  });

  transcriptInput.addEventListener('input', () => {
    saveTranscriptIfEnabled();
    parseAndRenderTranscript();
    updateStartButton();
  });

  // ---- Transcript parsing ----------------------------------------------------
  function parseAndRenderTranscript() {
    const rawText = transcriptInput.value;
    if (!rawText || !rawText.trim()) {
      linesContainer.innerHTML = `<p class="h-[45px] flex items-center justify-start px-5 text-gray-400 italic">Paste script & press Start Session...</p>`;
      linesData = [];
      allWords = [];
      currentWordIndex = 0;
      currentLineIndex = 0;
      return;
    }

    linesData = [];
    allWords = [];
    let globalWordIdx = 0;

    // Check if input consists of continuous long paragraphs with lines exceeding 8 words
    // If so, automatically format for optimal teleprompter phrasing
    const inputLines = rawText.split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean);
    const hasUnbrokenLongLines = inputLines.some((l) => l.split(/\s+/).length > 8);
    const effectiveText = (inputLines.length <= 3 && hasUnbrokenLongLines)
      ? formatScriptForPrompter(rawText)
      : rawText;

    // Split input by newlines to respect carriage returns / paragraph / section breaks
    const rawLines = effectiveText.split(/\r\n|\r|\n/);
    let prevWasBlank = false;

    for (let l = 0; l < rawLines.length; l++) {
      const trimmedLine = rawLines[l].trim();

      if (!trimmedLine) {
        // Blank line: represents a breath pause or section break
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
        ? formatScriptForPrompter(trimmedLine).split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean)
        : [trimmedLine];

      for (const chunk of lineChunks) {
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

    // Remove any trailing blank lines
    while (linesData.length > 0 && linesData[linesData.length - 1].isBlank) {
      linesData.pop();
    }

    if (linesData.length === 0 || allWords.length === 0) {
      linesContainer.innerHTML = `<p class="h-[45px] flex items-center justify-start px-5 text-gray-400 italic">Paste script & press Start Session...</p>`;
      currentWordIndex = 0;
      currentLineIndex = 0;
      return;
    }

    const rehearsalReasonMap = new Map();
    rehearsalWordsList.forEach((item) => {
      const clean = (typeof item === 'string' ? item : item.clean || item.word).toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
      if (clean && !rehearsalReasonMap.has(clean)) {
        const r = typeof item === 'object' && item.reason ? item.reason.toLowerCase() : 'stumbled';
        rehearsalReasonMap.set(clean, r);
      }
    });

    linesContainer.innerHTML = linesData.map((line) => {
      if (line.isBlank) {
        return `<div id="line-${line.lineIdx}" class="prompter-line prompter-line-blank select-none"><span class="inline-block w-8 h-[2px] bg-indigo-400/50 rounded-full"></span></div>`;
      }
      const wordsHTML = line.words
        .map((w) => {
          const clean = w.original.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
          const isDifficult = clean && difficultWordsSet.has(clean);
          const rehearsalReason = clean ? rehearsalReasonMap.get(clean) : null;
          let isRehearsal = false;
          if (rehearsalReason) {
            if (syncPrompterWithFilter && rehearsalFilter !== 'all') {
              isRehearsal = (rehearsalReason === rehearsalFilter);
            } else {
              isRehearsal = true;
            }
          }
          let extraClasses = '';
          if (isDifficult) {
            extraClasses = ` prompter-word-difficult style-${difficultStyle}`;
          } else if (isRehearsal) {
            extraClasses = ` prompter-word-difficult style-${difficultStyle} prompter-word-rehearsal prompter-word-rehearsal-${rehearsalReason}`;
          }
          return `<span id="w-${w.globalIdx}" class="prompter-word${extraClasses}">${w.original}</span>`;
        })
        .join(' ');
      return `<div id="line-${line.lineIdx}" class="prompter-line line-upcoming">${wordsHTML}</div>`;
    }).join('');

    currentWordIndex = 0;
    currentLineIndex = 0;
    updateHighlighting(0);
  }

  // ---- Highlighting & scrolling --------------------------------------------
  function updateHighlighting(wordIndex) {
    if (!allWords.length) return;

    const oldWord = linesContainer.querySelector('.word-active');
    if (oldWord) oldWord.classList.remove('word-active');

    const activeWordObj = allWords[wordIndex];
    if (!activeWordObj) return;

    currentWordIndex = wordIndex;
    currentLineIndex = activeWordObj.lineIdx;

    const wordSpan = document.getElementById(`w-${wordIndex}`);
    if (wordSpan) wordSpan.classList.add('word-active');

    const allLineDivs = linesContainer.querySelectorAll('.prompter-line');
    allLineDivs.forEach((lineEl, idx) => {
      if (idx === currentLineIndex) {
        lineEl.classList.remove('line-upcoming', 'line-past');
        lineEl.classList.add('line-active');
      } else if (idx > currentLineIndex) {
        lineEl.classList.remove('line-active', 'line-past');
        lineEl.classList.add('line-upcoming');
      } else {
        lineEl.classList.remove('line-active', 'line-upcoming');
        lineEl.classList.add('line-past');
      }
    });

    const translateY = -(currentLineIndex * 45);
    scrollingContent.style.transform = `translateY(${translateY}px)`;
  }

  // ---- Start / Rehearse / Stop -----------------------------------------------
  if (btnRehearse) {
    btnRehearse.addEventListener('click', () => {
      if (isPrompting) return;
      if (!transcriptInput.value.trim()) return;

      parseAndRenderTranscript();
      currentWordIndex = 0;
      isPrompting = true;
      isRehearsal = true;
      recordedChunks = [];

      if (optRecordMode) optRecordMode.disabled = true;
      if (optRecordFormat) optRecordFormat.disabled = true;

      if (audioContext && audioContext.state === 'suspended') audioContext.resume();

      if (activeAudioSource === 'browser' && audioContext && audioContext.state === 'running') {
        startBrowserAudioStream();
      }

      mediaRecorder = null;
      recIndicator.classList.add('hidden');

      send({ type: 'start', words: allWords.map((w) => w.original), rehearsal: true, wpm: 140 });

      updateStopButtonText();
      btnStart.classList.add('hidden');
      btnRehearse.classList.add('hidden');
      btnStop.classList.remove('hidden');
      updateHighlighting(0);
      updateStartButton();
      setBadge(vadStatus, 'REHEARSAL (CATCHING FUMBLES)', 'bg-emerald-950 text-emerald-400 border-emerald-500/30');
      speechHud.textContent = 'Trial read-through: read naturally. Skipped, stumbled, or repeated words will be caught!';
    });
  }

  btnStart.addEventListener('click', () => {
    if (isPrompting) return;
    if (!transcriptInput.value.trim()) return;

    parseAndRenderTranscript();
    currentWordIndex = 0;
    isPrompting = true;
    isRehearsal = false;
    recordedChunks = [];

    activeRecordMode = optRecordMode ? optRecordMode.value : 'video';
    if (optRecordMode) optRecordMode.disabled = true;
    if (optRecordFormat) optRecordFormat.disabled = true;

    if (audioContext && audioContext.state === 'suspended') audioContext.resume();

    if (activeAudioSource === 'browser' && audioContext && audioContext.state === 'running') {
      startBrowserAudioStream();
    }

    if (activeRecordMode !== 'off') {
      try {
        const tracksToRecord = [];
        if (activeRecordMode === 'video' && videoStream) {
          tracksToRecord.push(...videoStream.getVideoTracks().filter((t) => t.readyState === 'live'));
        }
        if (audioStream) {
          tracksToRecord.push(...audioStream.getAudioTracks().filter((t) => t.readyState === 'live'));
        }

        if (tracksToRecord.length > 0) {
          const hasVideoTrack = tracksToRecord.some((t) => t.kind === 'video');
          if (activeRecordMode === 'audio' || !hasVideoTrack) {
            activeRecordingOptions = getAudioRecorderOptions(activeAudioFormat);
          } else {
            activeRecordingOptions = getVideoRecorderOptions(activeVideoFormat);
          }

          const streamToRecord = new MediaStream(tracksToRecord);
          const recorderOpts = activeRecordingOptions.mimeType ? { mimeType: activeRecordingOptions.mimeType } : {};
          mediaRecorder = new MediaRecorder(streamToRecord, recorderOpts);
          mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
          mediaRecorder.start(1000);
          recIndicator.classList.remove('hidden');
        } else {
          mediaRecorder = null;
          recIndicator.classList.add('hidden');
        }
      } catch (_) {
        speechHud.textContent = 'Recording unavailable – running sync-only.';
        mediaRecorder = null;
        recIndicator.classList.add('hidden');
      }
    } else {
      mediaRecorder = null;
      recIndicator.classList.add('hidden');
    }

    send({ type: 'start', words: allWords.map((w) => w.original), wpm: 140 });

    updateStopButtonText();
    btnStart.classList.add('hidden');
    if (btnRehearse) btnRehearse.classList.add('hidden');
    btnStop.classList.remove('hidden');
    updateHighlighting(0);
    updateStartButton();
    setBadge(vadStatus, 'LISTENING (LOCAL WHISPER)', 'bg-indigo-950 text-indigo-400 border-indigo-500/30');
    speechHud.textContent = 'Speak into the mic to scroll in sync…';
  });

  btnStop.addEventListener('click', () => {
    isPrompting = false;
    stopBrowserAudioStream();
    if (optRecordMode) optRecordMode.disabled = false;
    if (optRecordFormat) optRecordFormat.disabled = false;

    send({ type: 'stop' });

    if (activeRecordMode !== 'off' && mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.onstop = async () => {
        function getRecordingFilename(extension) {
          const prefix = activeRecordMode === 'audio' ? 'Teleprompter-Audio' : 'Teleprompter-Session';
          const now = new Date();
          const pad = (n) => String(n).padStart(2, '0');
          const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
          return `${prefix}-${dateStr}.${extension}`;
        }

        try {
          const recordedBlob = new Blob(recordedChunks, { type: activeRecordingOptions.mimeType || 'audio/webm' });
          let finalBlob = recordedBlob;
          let finalExtension = activeRecordingOptions.extension;

          // Convert to WAV or MP3 for audio if selected
          if (activeRecordMode === 'audio' && (activeAudioFormat === 'wav' || activeAudioFormat === 'mp3')) {
            setBadge(vadStatus, 'ENCODING…', 'bg-yellow-950 text-yellow-400 border-yellow-500/30');
            speechHud.textContent = `Processing ${activeAudioFormat.toUpperCase()} audio…`;

            const arrayBuffer = await recordedBlob.arrayBuffer();
            const decodeContext = new (window.AudioContext || window.webkitAudioContext)();
            const audioBuffer = await decodeContext.decodeAudioData(arrayBuffer);

            if (activeAudioFormat === 'wav') {
              finalBlob = audioBufferToWav(audioBuffer);
              finalExtension = 'wav';
            } else if (activeAudioFormat === 'mp3') {
              finalBlob = audioBufferToMp3(audioBuffer, 192);
              finalExtension = 'mp3';
            }
            try { decodeContext.close(); } catch (_) { }
          }

          const url = URL.createObjectURL(finalBlob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          a.download = getRecordingFilename(finalExtension);
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
          }, 150);

          setBadge(vadStatus, 'SAVED', 'bg-green-950 text-green-400 border-green-500/30');
          speechHud.textContent = activeRecordMode === 'audio'
            ? `Session audio saved (${finalExtension.toUpperCase()})!`
            : `Session video saved (${finalExtension.toUpperCase()})!`;
        } catch (err) {
          console.error('Error processing audio recording:', err);
          // Fallback to saving raw blob directly
          const fallbackBlob = new Blob(recordedChunks, { type: activeRecordingOptions.mimeType || 'audio/webm' });
          const url = URL.createObjectURL(fallbackBlob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          a.download = getRecordingFilename(activeRecordingOptions.extension);
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
          }, 150);
          setBadge(vadStatus, 'SAVED', 'bg-green-950 text-green-400 border-green-500/30');
          speechHud.textContent = 'Session saved!';
        }
      };
      mediaRecorder.stop();
    } else {
      if (isRehearsal) {
        setBadge(vadStatus, 'REHEARSAL COMPLETE', 'bg-emerald-950 text-emerald-400 border-emerald-500/30');
        const count = rehearsalWordsList.length;
        speechHud.textContent = `Trial complete! ${count} fumbled ${count === 1 ? 'word' : 'words'} highlighted for your live take.`;
      } else {
        setBadge(vadStatus, 'STOPPED', 'bg-gray-800 text-gray-400 border-gray-700');
        speechHud.textContent = 'Session ended.';
      }
    }

    btnStart.classList.remove('hidden');
    if (btnRehearse) btnRehearse.classList.remove('hidden');
    btnStop.classList.add('hidden');
    recIndicator.classList.add('hidden');
    isRehearsal = false;
    updateStopButtonText();
    updateStartButton();
  });

  // ---- Keyboard manual stepping (local override + backend sync) ------------
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === transcriptInput) return;
    if (e.code === 'ArrowDown' && allWords.length) {
      currentWordIndex = Math.min(allWords.length - 1, currentWordIndex + 1);
      updateHighlighting(currentWordIndex);
      send({ type: 'seek', word_index: currentWordIndex });
    } else if (e.code === 'ArrowUp' && allWords.length) {
      currentWordIndex = Math.max(0, currentWordIndex - 1);
      updateHighlighting(currentWordIndex);
      send({ type: 'seek', word_index: currentWordIndex });
    }
  });

  // ---- Interactive word clicking -------------------------------------------
  linesContainer.addEventListener('click', (e) => {
    const wordSpan = e.target.closest('span[id^="w-"]');
    if (wordSpan) {
      const idx = parseInt(wordSpan.id.replace('w-', ''), 10);
      if (!isNaN(idx) && idx >= 0 && idx < allWords.length) {
        currentWordIndex = idx;
        updateHighlighting(idx);
        send({ type: 'seek', word_index: idx });
      }
    }
  });

  if (btnReset) {
    btnReset.addEventListener('click', () => {
      if (allWords.length > 0) {
        currentWordIndex = 0;
        currentLineIndex = 0;
        updateHighlighting(0);
        send({ type: 'seek', word_index: 0 });
      } else {
        parseAndRenderTranscript();
      }
      speechHud.textContent = 'Script reset to start.';
    });
  }

  document.getElementById('btn-toggle-panel').addEventListener('click', () => {
    document.getElementById('side-panel').classList.toggle('hidden');
  });

  // ---- Boot ------------------------------------------------------------------
  updateFormatUI();
  updateAudioSourceUI(activeAudioSource);
  applyDifficultColorStyles();
  renderDifficultTags();
  renderRehearsalTags();
  if (optFontsize) {
    linesContainer.style.fontSize = `${optFontsize.value}px`;
  }
  if (persistTranscript) {
    const savedTranscript = localStorage.getItem('teleprompter_saved_transcript');
    if (savedTranscript && (!transcriptInput.value || !transcriptInput.value.trim())) {
      transcriptInput.value = savedTranscript;
    }
  }
  updateClearButtonVisibility();
  parseAndRenderTranscript();
  initCameraAndAudio();
  updateViewportLines(parseInt(optLines.value, 10));
  connect();
})();