(() => {
  'use strict';

  // ---- Global state -------------------------------------------------------
  const configStore = typeof window !== 'undefined' && window.TeleprompterConfig
    ? window.TeleprompterConfig.createConfigStore({
        onPatch: (domain, patchData) => {
          send({ type: 'config_patch', domain, data: patchData });
        }
      })
    : null;

  const mediaSession = new TeleprompterMedia.MediaSession();
  if (typeof window !== 'undefined') {
    window.mediaSession = mediaSession;
  }
  let isPrompting = false;
  let isRehearsal = false;

  // Transcript state
  let linesData = [];
  let allWords = [];
  let parsedSections = [];
  let currentActiveSectionId = null;
  let sessionStartTime = 0;
  let currentWordIndex = 0;
  let currentLineIndex = 0;

  // Server / engine state
  let ws = null;
  let wsConnected = false;
  let modelReady = false;
  let browserAudio = false;

  // Browser-audio streaming state handled by mediaSession

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
  const vuSource = document.getElementById('vu-source');
  const btnRefreshAudioDevices = document.getElementById('btn-refresh-audio-devices');
  const btnRetake = document.getElementById('btn-retake');
  const btnRetakeText = document.getElementById('btn-retake-text');
  const optRetakeHotkey = document.getElementById('opt-retake-hotkey');


  let retakeHotkey = (configStore && configStore.get('ui.retake_hotkey')) || 'r';
  if (optRetakeHotkey) {
    optRetakeHotkey.value = retakeHotkey.toUpperCase();
    optRetakeHotkey.addEventListener('input', (e) => {
      const val = (e.target.value || '').trim().toLowerCase().slice(0, 1) || 'r';
      retakeHotkey = val;
      optRetakeHotkey.value = val.toUpperCase();
      if (configStore) {
        configStore.set('ui.retake_hotkey', retakeHotkey);
      }
    });
  }

  // MediaSession event hooks
  mediaSession.onVuLevel = (levelPercent) => {
    renderVuLevel(levelPercent);
  };
  mediaSession.onAudioChunk = (pcm16k) => {
    if (!isPrompting || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (activeAudioSource !== 'browser') return;
    send({ type: 'audio', data: Array.from(pcm16k) });
  };
  mediaSession.onDeviceChanged = (label) => {
    if (vuSource) {
      vuSource.textContent = label.replace(/\s*\(System Default\)\s*/i, '');
    }
  };

  let autoFormatOnPaste = configStore
    ? configStore.get('ui.auto_format_on_paste')
    : (localStorage.getItem('teleprompter_auto_format_paste') !== 'false');
  if (optAutoFormatOnPaste) {
    optAutoFormatOnPaste.checked = autoFormatOnPaste;
    optAutoFormatOnPaste.addEventListener('change', (e) => {
      autoFormatOnPaste = e.target.checked;
      if (configStore) configStore.set('ui.auto_format_on_paste', autoFormatOnPaste);
      localStorage.setItem('teleprompter_auto_format_paste', String(autoFormatOnPaste));
    });
  }

  let persistTranscript = configStore
    ? configStore.get('ui.persist_transcript')
    : (localStorage.getItem('teleprompter_persist_transcript') !== 'false');
  if (optPersistTranscript) {
    optPersistTranscript.checked = persistTranscript;
    optPersistTranscript.addEventListener('change', (e) => {
      persistTranscript = e.target.checked;
      if (configStore) configStore.set('ui.persist_transcript', persistTranscript);
      localStorage.setItem('teleprompter_persist_transcript', String(persistTranscript));
      if (persistTranscript) {
        if (transcriptInput && transcriptInput.value) {
          if (configStore) configStore.set('script.saved_transcript', transcriptInput.value);
          localStorage.setItem('teleprompter_saved_transcript', transcriptInput.value);
        }
        showFormatToast('Persistence enabled ✓');
      } else {
        if (configStore) configStore.set('script.saved_transcript', '');
        localStorage.removeItem('teleprompter_saved_transcript');
        showFormatToast('Persistence disabled');
      }
    });
  }

  function saveTranscriptIfEnabled() {
    if (persistTranscript) {
      if (transcriptInput && transcriptInput.value && transcriptInput.value.trim()) {
        if (configStore) configStore.set('script.saved_transcript', transcriptInput.value);
        localStorage.setItem('teleprompter_saved_transcript', transcriptInput.value);
      } else {
        if (configStore) configStore.set('script.saved_transcript', '');
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
        if (configStore) configStore.set('script.saved_transcript', '');
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
      if (configStore) configStore.set('script.saved_transcript', transcriptInput.value);
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
  const optBoxWidth = document.getElementById('opt-boxwidth');
  const valBoxWidth = document.getElementById('val-boxwidth');
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
  let activeAudioSource = configStore
    ? (configStore.get('audio.device_id') || (configStore.get('audio.source_type') === 'browser' ? 'browser' : 'hardware'))
    : (localStorage.getItem('teleprompter_audio_device') || 'browser');
  let activeAudioSourceName = configStore
    ? (configStore.get('audio.device_name') || '')
    : (localStorage.getItem('teleprompter_audio_device_name') || '');
  let availableAudioDevices = [];
  let analyserSource = null;
  let lastLocalLevelTime = 0;

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
    const savedEngine = configStore
      ? configStore.get('engine.profile')
      : (localStorage.getItem('teleprompter_engine_speed') || 'fast');
    optEngineSpeed.value = savedEngine;
    updateEngineUI(savedEngine);

    optEngineSpeed.addEventListener('change', (e) => {
      const mode = e.target.value;
      if (configStore) configStore.set('engine.profile', mode);
      localStorage.setItem('teleprompter_engine_speed', mode);
      updateEngineUI(mode);
      send({ type: 'set_engine', mode: mode });
    });
  }

  // ---- Difficult Words State & Configuration -------------------------------
  let difficultWordsList = [];
  try {
    if (configStore && Array.isArray(configStore.get('ui.difficult_words'))) {
      difficultWordsList = configStore.get('ui.difficult_words');
    } else {
      const savedWords = localStorage.getItem('teleprompter_difficult_words');
      if (savedWords) difficultWordsList = JSON.parse(savedWords);
    }
  } catch (_) {
    difficultWordsList = [];
  }

  let difficultColor = configStore ? configStore.get('ui.difficult_color') : (localStorage.getItem('teleprompter_difficult_color') || '#f59e0b');
  let difficultStyle = configStore ? configStore.get('ui.difficult_style') : (localStorage.getItem('teleprompter_difficult_style') || 'pill');

  let difficultWordsSet = new Set(
    difficultWordsList.map((w) => w.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '')).filter(Boolean)
  );

  // ---- Rehearsal / Trial Fumbled Words State ------------------------------
  let rehearsalWordsList = [];
  try {
    if (configStore && Array.isArray(configStore.get('script.rehearsal_words'))) {
      rehearsalWordsList = configStore.get('script.rehearsal_words');
    } else {
      const savedRehearsal = localStorage.getItem('teleprompter_rehearsal_words');
      if (savedRehearsal) rehearsalWordsList = JSON.parse(savedRehearsal);
    }
  } catch (_) {
    rehearsalWordsList = [];
  }

  let rehearsalWordsSet = new Set(
    rehearsalWordsList.map((item) => (typeof item === 'string' ? item : item.clean || item.word).toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '')).filter(Boolean)
  );

  let rehearsalFilter = 'all'; // 'all' | 'skipped' | 'stumbled' | 'repeated'
  let syncPrompterWithFilter = configStore ? configStore.get('ui.sync_fumble_filter') : false;
  try {
    if (!configStore) syncPrompterWithFilter = localStorage.getItem('teleprompter_sync_fumble_filter') === 'true';
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
    if (configStore) {
      configStore.set('script.rehearsal_words', rehearsalWordsList);
    }
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
    if (configStore) {
      configStore.update('ui', {
        difficult_words: difficultWordsList,
        difficult_color: difficultColor,
        difficult_style: difficultStyle
      });
    }
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
      if (configStore) configStore.set('ui.sync_fumble_filter', syncPrompterWithFilter);
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
          if (d.raw_name) opt.dataset.rawName = d.raw_name;
          if (String(d.id) === String(deviceId)) opt.selected = true;
          optAudioSource.appendChild(opt);
        });
      }
    }
    activeAudioSource = String(deviceId);
    if (optAudioSource) {
      optAudioSource.value = activeAudioSource;
    }
    const matchedDev = availableAudioDevices.find((d) => String(d.id) === String(activeAudioSource));
    if (matchedDev && (matchedDev.raw_name || matchedDev.name)) {
      activeAudioSourceName = matchedDev.raw_name || matchedDev.name;
      localStorage.setItem('teleprompter_audio_device_name', activeAudioSourceName);
    }
    const isBrowser = activeAudioSource === 'browser';
    if (audioSourceBadge) {
      const devName = matchedDev ? (matchedDev.raw_name || matchedDev.name).replace(/\s*\(System Default\)\s*/i, '') : '';
      audioSourceBadge.textContent = isBrowser ? 'Browser Mic' : (devName || 'Hardware Mic');
      audioSourceBadge.className = 'text-[10px] px-1.5 py-0.5 rounded font-mono border ' +
        (isBrowser ? 'bg-green-950 text-green-300 border-green-700/50' : 'bg-indigo-950 text-indigo-300 border-indigo-700/50');
    }
    if (audioSourceDesc) {
      const devName = matchedDev ? (matchedDev.raw_name || matchedDev.name).replace(/\s*\(System Default\)\s*/i, '') : 'selected mic';
      audioSourceDesc.textContent = isBrowser
        ? 'Streams directly from your active browser tab mic (matches VU meter).'
        : `Backend captures directly from ${devName} for Whisper. Browser records & monitors ${devName}.`;
    }
    if (vuSource) {
      const devName = matchedDev ? (matchedDev.raw_name || matchedDev.name).replace(/\s*\(System Default\)\s*/i, '') : (isBrowser ? 'Browser' : 'Mic');
      vuSource.textContent = devName;
    }
  }

  if (optAudioSource) {
    optAudioSource.addEventListener('change', async (e) => {
      const devId = e.target.value;
      activeAudioSource = devId;
      localStorage.setItem('teleprompter_audio_device', devId);
      const matchedDev = availableAudioDevices.find((d) => String(d.id) === String(devId));
      const targetName = matchedDev ? (matchedDev.raw_name || matchedDev.name) : null;
      if (targetName) {
        activeAudioSourceName = targetName;
        localStorage.setItem('teleprompter_audio_device_name', targetName);
      }
      updateAudioSourceUI(devId);
      send({ type: 'set_audio_device', device: devId });
      await switchBrowserAudio(targetName);
      if (devId === 'browser') {
        if (isPrompting) startBrowserAudioStream();
      } else {
        stopBrowserAudioStream();
      }
    });
  }

  if (btnRefreshAudioDevices) {
    btnRefreshAudioDevices.addEventListener('click', async () => {
      btnRefreshAudioDevices.classList.add('opacity-50');
      send({ type: 'refresh_audio_devices' });
      await switchBrowserAudio(activeAudioSourceName);
      setTimeout(() => btnRefreshAudioDevices.classList.remove('opacity-50'), 400);
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

  let activeRecordMode = configStore ? configStore.get('recording.mode') : (localStorage.getItem('teleprompter_record_mode') || 'video');
  if (optRecordMode) optRecordMode.value = activeRecordMode;

  let activeVideoFormat = configStore ? configStore.get('recording.video_format') : (localStorage.getItem('teleprompter_video_format') || 'mp4');
  let activeAudioFormat = configStore ? configStore.get('recording.audio_format') : (localStorage.getItem('teleprompter_audio_format') || 'mp3');
  let activeRecordingOptions = { mimeType: '', extension: 'webm', format: 'webm' };

  function updateFormatUI() {
    const mode = optRecordMode ? optRecordMode.value : 'video';
    activeRecordMode = mode;
    if (configStore) {
      configStore.update('recording', {
        mode: activeRecordMode,
        video_format: activeVideoFormat,
        audio_format: activeAudioFormat
      });
    }
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
      if (configStore) {
        configStore.update('recording', {
          mode: activeRecordMode,
          video_format: activeVideoFormat,
          audio_format: activeAudioFormat
        });
      }
      const formats = mode === 'video' ? VIDEO_FORMATS : AUDIO_FORMATS;
      const chosen = formats.find((f) => f.id === e.target.value);
      if (formatDesc && chosen) formatDesc.textContent = chosen.desc;
      updateStopButtonText();
    });
  }

  // ---- Audio Encoders & Recorder Options (Delegated to TeleprompterMedia) ----
  const {
    audioBufferToWav,
    audioBufferToMp3,
    getAudioRecorderOptions,
    getVideoRecorderOptions
  } = TeleprompterMedia;

  function updateStopButtonText() {
    if (!btnStop) return;
    const isHidden = btnStop.classList.contains('hidden') || !isPrompting;
    if (isRehearsal) {
      btnStop.textContent = 'Finish Rehearsal';
      btnStop.className = 'px-4 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold rounded shadow transition cursor-pointer' + (isHidden ? ' hidden' : '');
      return;
    }
    btnStop.className = 'px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-semibold rounded shadow transition cursor-pointer' + (isHidden ? ' hidden' : '');
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
        if (msg.config && configStore) {
          configStore.reconcileServerConfig(msg.config);
        }
        if (msg.profile) {
          const saved = configStore ? configStore.get('engine.profile') : localStorage.getItem('teleprompter_engine_speed');
          if (!saved) updateEngineUI(msg.profile);
        }
        if (msg.audio_devices) {
          const savedDev = configStore ? configStore.get('audio.device_id') : localStorage.getItem('teleprompter_audio_device');
          const activeDev = savedDev || (msg.browser_audio ? 'browser' : msg.active_audio_device) || 'browser';
          updateAudioSourceUI(activeDev, msg.audio_devices);
          const matchedDev = (msg.audio_devices || []).find((d) => String(d.id) === String(activeDev));
          const targetName = matchedDev ? (matchedDev.raw_name || matchedDev.name) : activeAudioSourceName;
          if (targetName) {
            activeAudioSourceName = targetName;
            if (configStore) {
              configStore.update('audio', {
                source_type: activeDev === 'browser' ? 'browser' : 'hardware',
                device_id: activeDev === 'browser' ? null : String(activeDev),
                device_name: targetName
              });
            }
            localStorage.setItem('teleprompter_audio_device_name', targetName);
            switchBrowserAudio(targetName);
          }
          if (savedDev && String(savedDev) !== String(msg.active_audio_device)) {
            send({ type: 'set_audio_device', device: savedDev });
          }
        }
        if (activeAudioSource === 'browser' && isPrompting) {
          mediaSession.ensureAudioContext().then(() => startBrowserAudioStream()).catch(() => {});
        }
        break;
      case 'config_updated':
        if (msg.config && configStore) {
          configStore.reconcileServerConfig(msg.config);
        }
        if (msg.domain === 'ui' && msg.data) {
          if (msg.data.box_width_pct !== undefined && optBoxWidth) {
            const widthVal = msg.data.box_width_pct;
            optBoxWidth.value = widthVal;
            prompterBox.style.width = `${widthVal}%`;
            prompterBox.style.maxWidth = `${widthVal}%`;
            if (valBoxWidth) valBoxWidth.textContent = `${widthVal}%`;
          }
        }
        break;
      case 'audio_device_changed':
        if (isPrompting) {
          console.log('[AUDIO] Ignoring background audio_device_changed event while session is active');
          break;
        }
        updateAudioSourceUI(msg.device);
        const switchedDev = availableAudioDevices.find((d) => String(d.id) === String(msg.device));
        if (switchedDev) {
          const tName = switchedDev.raw_name || switchedDev.name;
          activeAudioSourceName = tName;
          localStorage.setItem('teleprompter_audio_device_name', tName);
          switchBrowserAudio(tName);
        }
        break;
      case 'vu':
        if (Date.now() - lastLocalLevelTime > 150) {
          renderVuLevel(msg.level);
        }
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
      case 'take_saved':
        if (msg.success) {
          setBadge(vadStatus, 'SAVED TO DISK', 'bg-emerald-950 text-emerald-400 border-emerald-500/30');
          speechHud.textContent = `Saved ${msg.filename} to recordings/ folder!`;
        } else {
          setBadge(vadStatus, 'ERROR', 'bg-red-950 text-red-400 border-red-500/30');
          speechHud.textContent = `⚠ Failed to save ${msg.filename}: ${msg.error}`;
        }
        takeSavedListeners.forEach((fn) => {
          try { fn(msg); } catch (_) {}
        });
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
      if (vadStatus.textContent !== 'SAVED' && !vadStatus.textContent.includes('SAVED') && vadStatus.textContent !== 'ENCODING…') {
        if (activeRecordMode === 'off' || !mediaSession.mediaRecorder || mediaSession.mediaRecorder.state === 'inactive') {
          speechHud.textContent = 'Session ended.';
        }
      }
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
  let vuLoopStarted = false;

  function renderVuLevel(levelPercent) {
    if (!vuBar || !vuText) return;
    vuBar.style.width = levelPercent + '%';
    vuText.textContent = levelPercent + '%';

    // Visual gain indicator: green (normal), amber (optimal high), red (clipping/peaking)
    if (levelPercent > 85) {
      vuBar.className = 'bg-red-500 h-full transition-all duration-75';
      vuText.className = 'text-[10px] font-mono text-red-400 font-semibold';
    } else if (levelPercent > 60) {
      vuBar.className = 'bg-yellow-400 h-full transition-all duration-75';
      vuText.className = 'text-[10px] font-mono text-yellow-400 font-semibold';
    } else {
      vuBar.className = 'bg-green-500 h-full transition-all duration-75';
      vuText.className = 'text-[10px] font-mono text-gray-400';
    }

    const threshold = parseInt(optSens.value, 10);
    if (levelPercent > threshold) {
      if (!vuBar.dataset.speaking) {
        vuBar.dataset.speaking = '1';
        if (isPrompting) {
          setBadge(vadStatus, 'VOICE DETECTED', 'bg-green-950 text-green-400 border-green-500/30');
        }
      }
    } else {
      if (vuBar.dataset.speaking) {
        delete vuBar.dataset.speaking;
        if (isPrompting) {
          setBadge(vadStatus, 'HOLDING – SILENCE', 'bg-yellow-950 text-yellow-400 border-yellow-500/30');
        }
      }
    }
  }

  async function switchBrowserAudio(preferredName) {
    try {
      const activeLabel = await mediaSession.switchAudioDevice(preferredName);
      if (activeLabel && vuSource) {
        vuSource.textContent = activeLabel.replace(/\s*\(System Default\)\s*/i, '');
      }
      if (activeAudioSource === 'browser' && isPrompting) {
        stopBrowserAudioStream();
        startBrowserAudioStream();
      }
    } catch (err) {
      console.warn('Microphone access / switch warning:', err);
    }
  }

  async function initAudio() {
    const target = activeAudioSourceName || (activeAudioSource !== 'browser' ? activeAudioSource : null);
    await mediaSession.initAudio(target);
  }

  // Resume AudioContext and ensure audio init on any initial user interaction
  const resumeAudioOnGesture = () => {
    mediaSession.ensureAudioContext();
    if (!mediaSession.audioStream) {
      initAudio();
    }
  };
  ['click', 'keydown', 'pointerdown', 'touchstart'].forEach((evt) => {
    window.addEventListener(evt, resumeAudioOnGesture, { passive: true });
  });

  // ---- Camera controls & stream lifecycle -----------------------------------
  async function startCamera() {
    try {
      await mediaSession.startCamera(videoElem);
    } catch (err) {
      alert('Camera access error: ' + err.message);
    }
  }

  function stopCamera() {
    mediaSession.stopCamera(videoElem);
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
    if (activeAudioSource !== 'browser') return;
    mediaSession.startStreaming();
    send({ type: 'set_audio_device', device: 'browser' });
  }

  function stopBrowserAudioStream() {
    mediaSession.stopStreaming();
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

  function getLineHeightForFontSize(fontSize) {
    return Math.max(36, Math.round(fontSize * 1.8));
  }

  let currentLineHeight = getLineHeightForFontSize(optFontsize ? parseInt(optFontsize.value, 10) || 25 : 25);

  optFontsize.addEventListener('input', (e) => {
    const newSize = parseInt(e.target.value, 10);
    linesContainer.style.fontSize = `${newSize}px`;
    document.getElementById('val-fontsize').textContent = `${newSize}px`;
    currentLineHeight = getLineHeightForFontSize(newSize);
    updateViewportLines(parseInt(optLines.value, 10));
    const translateY = -(currentLineIndex * currentLineHeight);
    scrollingContent.style.transform = `translateY(${translateY}px)`;
  });

  if (optBoxWidth) {
    optBoxWidth.addEventListener('input', (e) => {
      const widthVal = parseInt(e.target.value, 10);
      prompterBox.style.width = `${widthVal}%`;
      prompterBox.style.maxWidth = `${widthVal}%`;
      if (valBoxWidth) valBoxWidth.textContent = `${widthVal}%`;
      if (configStore) configStore.set('ui.box_width_pct', widthVal);
      localStorage.setItem('teleprompter_box_width_pct', String(widthVal));
    });
  }

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
    const lineH = currentLineHeight;
    document.documentElement.style.setProperty('--prompter-line-height', `${lineH}px`);
    viewingWindow.style.height = (numLines * lineH) + 'px';
    cursorBar.style.top = (activeLineOffset * lineH) + 'px';
    cursorBar.style.height = lineH + 'px';
    scrollingContent.style.paddingTop = (activeLineOffset * lineH) + 'px';
  }

  // ---- Automatic Teleprompter Script Phrasing & Formatting -----------------
  function formatScriptForPrompter(text) {
    if (typeof TeleprompterFormatter !== 'undefined') {
      // C5: wire script.protected_terms from config; empty = formatter uses its defaults
      const configTerms = configStore ? configStore.get('script.protected_terms') : null;
      const opts = (Array.isArray(configTerms) && configTerms.length > 0)
        ? { protectedTerms: configTerms }
        : {};
      return TeleprompterFormatter.formatScript(text, opts);
    }
    return text;
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
      linesContainer.innerHTML = `<p class="prompter-line text-gray-400 italic">Paste script & press Start Session...</p>`;
      linesData = [];
      allWords = [];
      currentWordIndex = 0;
      currentLineIndex = 0;
      return;
    }

    if (typeof TeleprompterFormatter !== 'undefined') {
      // C5: wire script.protected_terms from config; empty = formatter uses its defaults
      const configTerms = configStore ? configStore.get('script.protected_terms') : null;
      const opts = (Array.isArray(configTerms) && configTerms.length > 0)
        ? { protectedTerms: configTerms }
        : {};
      const tokenResult = TeleprompterFormatter.parseTokens(rawText, opts);
      linesData = tokenResult.lines;
      allWords = tokenResult.allWords;
      parsedSections = tokenResult.sections || [];
    } else {
      linesData = [];
      allWords = [];
      parsedSections = [];
    }
    // Rebuild SectionTimeline whenever parsedSections is repopulated (C1)
    sectionTimeline = new SectionTimeline(parsedSections, () => (Date.now() - sessionStartTime) / 1000);

    if (linesData.length === 0 || allWords.length === 0) {
      linesContainer.innerHTML = `<p class="prompter-line text-gray-400 italic">Paste script & press Start Session...</p>`;
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
      if (line.isSectionHeader) {
        return `<div id="line-${line.lineIdx}" class="prompter-line prompter-line-section select-none"><span class="prompter-section-pill">[${line.sectionTitle}]</span></div>`;
      }
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
    if (parsedSections.length > 0 && btnRetakeText) {
      btnRetakeText.textContent = `Re-take [${parsedSections[0].title}]`;
    }
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

    if (parsedSections.length > 0 && activeWordObj.sectionId) {
      handleSectionWordProgress(activeWordObj);
    }

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

    const translateY = -(currentLineIndex * currentLineHeight);
    scrollingContent.style.transform = `translateY(${translateY}px)`;
  }

  // ---- SectionTimeline (C1) -------------------------------------------------
  // Owns all startSec / endSec mutation behind a 4-method interface.
  // Callers never touch parsedSections timestamps directly.
  class SectionTimeline {
    constructor(sections, getElapsedSec) {
      // sections[] is the shared parsedSections array (plain objects).
      // Mutation is concentrated here; all other code reads via getSectionMarkers().
      this._sections = sections;
      this._getElapsedSec = getElapsedSec; // () => seconds since session start
      this._activeId = null;
    }

    // Called on every word highlight when sections are active.
    wordSeen(word, isSessionActive) {
      const secId = word.sectionId;
      if (!secId) return;
      const nowSec = this._getElapsedSec();

      if (secId !== this._activeId) {
        // Close the previously active section (if any).
        if (this._activeId && isSessionActive) {
          const prev = this._sections.find((s) => s.id === this._activeId);
          if (prev && prev.startSec !== null && prev.endSec === null) {
            prev.endSec = nowSec;
          }
        }
        this._activeId = secId;
        // Open the newly active section.
        const cur = this._sections.find((s) => s.id === secId);
        if (cur && isSessionActive && cur.startSec === null) {
          cur.startSec = Math.max(0, nowSec - 0.1);
        }
        if (btnRetakeText && cur) {
          btnRetakeText.textContent = `Re-take [${cur.title}]`;
        }
      } else if (isSessionActive) {
        // Same section — ensure startSec is set if it somehow isn't yet.
        const cur = this._sections.find((s) => s.id === secId);
        if (cur && cur.startSec === null) {
          cur.startSec = Math.max(0, nowSec - 0.1);
        }
      }
    }

    // Resets timestamps for the current (or first) section and returns its startIndex for seek.
    retake() {
      const target = this._sections.find((s) => s.id === this._activeId) || this._sections[0];
      if (!target || target.startIndex === null) return null;
      target.startSec = null;
      target.endSec = null;
      return { seekIndex: target.startIndex, title: target.title };
    }

    // Closes the currently active section at the given elapsed second.
    close(nowSec) {
      if (!this._activeId) return;
      const sec = this._sections.find((s) => s.id === this._activeId);
      if (sec && sec.startSec !== null && sec.endSec === null) {
        sec.endSec = nowSec;
      }
      this._activeId = null;
    }

    // Returns the sections array (used by stopRecording and external readers).
    getSectionMarkers() {
      return this._sections;
    }

    // Resets all timestamps on all sections (called at session start).
    reset(activeId) {
      this._sections.forEach((s) => { s.startSec = null; s.endSec = null; });
      this._activeId = activeId || null;
    }

    get activeId() { return this._activeId; }
    set activeId(id) { this._activeId = id; }
  }

  // sectionTimeline is initialized when parsedSections is populated.
  let sectionTimeline = new SectionTimeline(parsedSections, () => (Date.now() - sessionStartTime) / 1000);

  // ---- Thin adapters (preserve external call sites unchanged) ---------------
  function handleSectionWordProgress(targetWord) {
    sectionTimeline.wordSeen(targetWord, isPrompting);
    currentActiveSectionId = sectionTimeline.activeId;
  }

  function triggerSectionRetake() {
    if (!isPrompting || parsedSections.length === 0) return;
    const result = sectionTimeline.retake();
    if (!result) return;

    currentWordIndex = result.seekIndex;
    updateHighlighting(currentWordIndex);
    send({ type: 'seek', word_index: currentWordIndex });

    setBadge(vadStatus, 'RE-TAKE READY', 'bg-amber-950 text-amber-300 border-amber-500/40');
    speechHud.textContent = `Re-taking [${result.title}]… speak from line start.`;
  }

  if (btnRetake) {
    btnRetake.addEventListener('click', triggerSectionRetake);
  }

  // ---- Start / Rehearse / Stop -----------------------------------------------
  if (btnRehearse) {
    btnRehearse.addEventListener('click', async () => {
      if (isPrompting) return;
      if (!transcriptInput.value.trim()) return;

      try {
        parseAndRenderTranscript();
        currentWordIndex = 0;
        isPrompting = true;
        isRehearsal = true;

        if (optRecordMode) optRecordMode.disabled = true;
        if (optRecordFormat) optRecordFormat.disabled = true;

        if (!mediaSession.audioStream || !mediaSession.audioStream.active || !mediaSession.audioStream.getAudioTracks().some((t) => t.readyState === 'live')) {
          await initAudio();
        }
        await mediaSession.ensureAudioContext();

        if (activeAudioSource === 'browser') {
          startBrowserAudioStream();
        }

        recIndicator.classList.add('hidden');

        send({ type: 'start', words: allWords.map((w) => w.original), rehearsal: true, wpm: 140, audio_device: activeAudioSource });

        updateStopButtonText();
        btnStart.classList.add('hidden');
        btnRehearse.classList.add('hidden');
        btnStop.classList.remove('hidden');
        updateHighlighting(0);
        updateStartButton();
        setBadge(vadStatus, 'REHEARSAL (CATCHING FUMBLES)', 'bg-emerald-950 text-emerald-400 border-emerald-500/30');
        speechHud.textContent = 'Trial read-through: read naturally. Skipped, stumbled, or repeated words will be caught!';
      } catch (err) {
        isPrompting = false;
        isRehearsal = false;
        if (optRecordMode) optRecordMode.disabled = false;
        if (optRecordFormat) optRecordFormat.disabled = false;
        updateStartButton();
        speechHud.textContent = '⚠ Error starting rehearsal: ' + (err && err.message ? err.message : String(err));
        setBadge(vadStatus, 'ERROR', 'bg-red-950 text-red-400 border-red-500/30');
      }
    });
  }

  btnStart.addEventListener('click', async () => {
    if (isPrompting) return;
    if (!transcriptInput.value.trim()) return;

    try {
      parseAndRenderTranscript();
      currentWordIndex = 0;
      isPrompting = true;
      isRehearsal = false;

      activeRecordMode = optRecordMode ? optRecordMode.value : 'video';
      if (optRecordMode) optRecordMode.disabled = true;
      if (optRecordFormat) optRecordFormat.disabled = true;

      if (!mediaSession.audioStream || !mediaSession.audioStream.active || !mediaSession.audioStream.getAudioTracks().some((t) => t.readyState === 'live')) {
        await initAudio();
      }
      await mediaSession.ensureAudioContext();

      if (activeAudioSource === 'browser') {
        startBrowserAudioStream();
      }

      if (activeRecordMode !== 'off') {
        try {
          console.log('[DEBUG START] Starting recording. mode:', activeRecordMode, 'audioFormat:', activeAudioFormat, 'videoFormat:', activeVideoFormat);
          await mediaSession.startRecording({
            mode: activeRecordMode,
            audioFormat: activeAudioFormat,
            videoFormat: activeVideoFormat
          });
          console.log('[DEBUG START] Recording started successfully. mediaRecorder state:', mediaSession.mediaRecorder ? mediaSession.mediaRecorder.state : 'null');
          recIndicator.classList.remove('hidden');
        } catch (recErr) {
          console.error('[DEBUG START ERROR] Failed to start recording:', recErr);
          speechHud.textContent = '⚠ Recording could not start: ' + (recErr && recErr.message ? recErr.message : String(recErr));
          setBadge(vadStatus, 'REC ERROR', 'bg-red-950 text-red-400 border-red-500/30');
          recIndicator.classList.add('hidden');
        }
      } else {
        recIndicator.classList.add('hidden');
      }

      send({ type: 'start', words: allWords.map((w) => w.original), wpm: 140, audio_device: activeAudioSource });

      sessionStartTime = Date.now();
      currentActiveSectionId = null;
      sectionTimeline.reset(parsedSections[0] ? parsedSections[0].id : null);
      if (parsedSections.length > 0) {
        if (btnRetake) {
          btnRetake.classList.remove('hidden');
          btnRetake.classList.add('flex');
          if (btnRetakeText) {
            btnRetakeText.textContent = `Re-take [${parsedSections[0].title}]`;
          }
        }
      } else {
        if (btnRetake) {
          btnRetake.classList.add('hidden');
          btnRetake.classList.remove('flex');
        }
      }

      updateStopButtonText();
      btnStart.classList.add('hidden');
      if (btnRehearse) btnRehearse.classList.add('hidden');
      btnStop.classList.remove('hidden');
      updateHighlighting(0);
      updateStartButton();
      setBadge(vadStatus, 'LISTENING (LOCAL WHISPER)', 'bg-indigo-950 text-indigo-400 border-indigo-500/30');
      if (recIndicator.classList.contains('hidden') && activeRecordMode !== 'off') {
        speechHud.textContent = 'Speech sync listening, but recording is inactive (check camera/mic permissions).';
      } else {
        speechHud.textContent = 'Speak into the mic to scroll in sync…';
      }
    } catch (err) {
      isPrompting = false;
      if (optRecordMode) optRecordMode.disabled = false;
      if (optRecordFormat) optRecordFormat.disabled = false;
      updateStartButton();
      speechHud.textContent = '⚠ Error starting session: ' + (err && err.message ? err.message : String(err));
      setBadge(vadStatus, 'ERROR', 'bg-red-950 text-red-400 border-red-500/30');
    }
  });

  btnStop.addEventListener('click', () => {
    console.log('[DEBUG STOP] clicked. activeRecordMode:', activeRecordMode, 'mediaRecorder:', mediaSession.mediaRecorder ? mediaSession.mediaRecorder.state : 'null');
    isPrompting = false;
    stopBrowserAudioStream();
    if (optRecordMode) optRecordMode.disabled = false;
    if (optRecordFormat) optRecordFormat.disabled = false;

    if (btnRetake) {
      btnRetake.classList.add('hidden');
      btnRetake.classList.remove('flex');
    }

    const sessionEndTime = Date.now();
    const totalSessionSec = (sessionEndTime - sessionStartTime) / 1000;
    // Close the active section via SectionTimeline (C1)
    sectionTimeline.close(totalSessionSec);
    currentActiveSectionId = null;

    send({ type: 'stop' });

    if (activeRecordMode !== 'off' && mediaSession.mediaRecorder && mediaSession.mediaRecorder.state !== 'inactive') {
      console.log('[DEBUG STOP] Calling mediaSession.stopRecording...');
      mediaSession.stopRecording({
        sections: sectionTimeline.getSectionMarkers(),
        sessionDurationSec: totalSessionSec,
        onProgress: (msg) => {
          console.log('[DEBUG STOP] Progress:', msg);
          setBadge(vadStatus, 'ENCODING…', 'bg-yellow-950 text-yellow-400 border-yellow-500/30');
          speechHud.textContent = msg;
        }
      }).then(async (result) => {
        console.log('[DEBUG STOP] stopRecording resolved with:', result);
        if (!result) return;
        const { blob, extension, filename, takes } = result;

        if (!blob || blob.size === 0) {
          setBadge(vadStatus, 'STOPPED', 'bg-gray-800 text-gray-400 border-gray-700');
          speechHud.textContent = 'Recording ended (no audio/video frames captured). Check microphone & camera permissions in Brave.';
          return;
        }

        const effectiveMode = (activeRecordMode === 'audio' || !mediaSession.hasRecordedVideoTrack) ? 'audio' : 'video';
        const exportTakes = (takes && takes.length > 0) ? takes : [
          {
            filename: filename,
            title: effectiveMode === 'audio' ? 'Master Session Audio' : 'Master Session Video',
            duration: totalSessionSec,
            blob: blob,
            isMaster: true
          }
        ];

        setBadge(vadStatus, 'READY TO EXPORT', 'bg-indigo-950 text-indigo-400 border-indigo-500/30');
        speechHud.textContent = 'Recording stopped. Choose your export options below.';

        // Present export modal with all takes and master file
        openExportModal(exportTakes, effectiveMode, extension);
      }).catch((err) => {
        console.error('Error saving recording:', err);
        setBadge(vadStatus, 'ERROR', 'bg-red-950 text-red-400 border-red-500/30');
        speechHud.textContent = '⚠ Error saving recording: ' + (err && err.message ? err.message : String(err));
      });
    } else {
      if (isRehearsal) {
        setBadge(vadStatus, 'REHEARSAL COMPLETE', 'bg-emerald-950 text-emerald-400 border-emerald-500/30');
        const count = rehearsalWordsList.length;
        speechHud.textContent = `Trial complete! ${count} fumbled ${count === 1 ? 'word' : 'words'} highlighted for your live take.`;
      } else {
        setBadge(vadStatus, 'STOPPED', 'bg-gray-800 text-gray-400 border-gray-700');
        speechHud.textContent = activeRecordMode === 'off'
          ? 'Session ended (sync-only).'
          : 'Session ended (no recording was active).';
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

  // ---- Keyboard manual stepping & Hotkeys ---------------------------------
  window.addEventListener('keydown', (e) => {
    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (activeTag === 'textarea' || activeTag === 'input') return;

    if (e.key.toLowerCase() === retakeHotkey.toLowerCase()) {
      if (isPrompting && parsedSections.length > 0) {
        e.preventDefault();
        triggerSectionRetake();
      }
      return;
    }

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
        currentActiveSectionId = parsedSections[0] ? parsedSections[0].id : null;
        if (parsedSections.length > 0 && btnRetakeText) {
          btnRetakeText.textContent = `Re-take [${parsedSections[0].title}]`;
        }
        updateHighlighting(0);
        send({ type: 'seek', word_index: 0 });
      } else {
        parseAndRenderTranscript();
      }
      speechHud.textContent = 'Script reset to start.';
    });
  }

  // ---- Export Modal & Delivery Subsystem ------------------------------------
  const exportSession = (typeof TeleprompterExport !== 'undefined')
    ? TeleprompterExport.init({
        modalEl: document.getElementById('modal-export'),
        takesList: document.getElementById('export-takes-list'),
        summaryEl: document.getElementById('export-summary-text'),
        badgeEl: document.getElementById('export-mode-badge'),
        speechHudEl: speechHud,
        createZipFn: (files) => (typeof TeleprompterMedia !== 'undefined' && TeleprompterMedia.createZipBlob ? TeleprompterMedia.createZipBlob(files) : Promise.reject(new Error('Zip unavailable'))),
      })
    : null;

  // Preserve external call sites unchanged.
  function openExportModal(takes, mode, format) { if (exportSession) exportSession.open(takes, mode, format); }
  function closeExportModal() { if (exportSession) exportSession.close(); }


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
    const initialFontSize = parseInt(optFontsize.value, 10) || 25;
    linesContainer.style.fontSize = `${initialFontSize}px`;
    currentLineHeight = getLineHeightForFontSize(initialFontSize);
  }
  if (optBoxWidth) {
    const savedBoxWidth = configStore ? configStore.get('ui.box_width_pct') : localStorage.getItem('teleprompter_box_width_pct');
    const widthToApply = savedBoxWidth ? parseInt(savedBoxWidth, 10) : 68;
    optBoxWidth.value = widthToApply;
    prompterBox.style.width = `${widthToApply}%`;
    prompterBox.style.maxWidth = `${widthToApply}%`;
    if (valBoxWidth) valBoxWidth.textContent = `${widthToApply}%`;
  }
  if (persistTranscript) {
    const savedTranscript = configStore ? configStore.get('script.saved_transcript') : localStorage.getItem('teleprompter_saved_transcript');
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