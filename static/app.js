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

  const initialAudioSource = configStore
    ? (configStore.get('audio.device_id') || (configStore.get('audio.source_type') === 'browser' ? 'browser' : 'hardware'))
    : (typeof localStorage !== 'undefined' ? localStorage.getItem('teleprompter_audio_device') || 'browser' : 'browser');
  const initialAudioSourceName = configStore
    ? (configStore.get('audio.device_name') || '')
    : (typeof localStorage !== 'undefined' ? localStorage.getItem('teleprompter_audio_device_name') || '' : '');
  const initialRecordMode = configStore
    ? configStore.get('recording.mode')
    : (typeof localStorage !== 'undefined' ? localStorage.getItem('teleprompter_record_mode') || 'video' : 'video');
  const initialVideoFormat = configStore
    ? configStore.get('recording.video_format')
    : (typeof localStorage !== 'undefined' ? localStorage.getItem('teleprompter_video_format') || 'mp4' : 'mp4');
  const initialAudioFormat = configStore
    ? configStore.get('recording.audio_format')
    : (typeof localStorage !== 'undefined' ? localStorage.getItem('teleprompter_audio_format') || 'mp3' : 'mp3');

  const mediaSession = new TeleprompterMedia.MediaSession({
    activeAudioSource: initialAudioSource,
    activeAudioSourceName: initialAudioSourceName,
    activeRecordMode: initialRecordMode,
    activeVideoFormat: initialVideoFormat,
    activeAudioFormat: initialAudioFormat,
    configStore
  });
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
  let serverControl = null;
  let scriptEditor = null;

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
  const btnClearHighlights = document.getElementById('btn-clear-highlights');
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
  const btnRestartServer = document.getElementById('btn-restart-server');
  const btnShutdownServer = document.getElementById('btn-shutdown-server');
  const serverStatusPill = document.getElementById('server-status-pill');
  const modalServerAction = document.getElementById('modal-server-action');
  const serverActionIcon = document.getElementById('server-action-icon');
  const serverActionTitle = document.getElementById('server-action-title');
  const serverActionDesc = document.getElementById('server-action-desc');
  const serverActionFooter = document.getElementById('server-action-footer');

  // Processing & take slicing progress modal elements
  const modalProcessing = document.getElementById('modal-processing');
  const processingProgressBar = document.getElementById('processing-progress-bar');
  const processingPercentText = document.getElementById('processing-percent-text');
  const processingPhaseText = document.getElementById('processing-phase-text');
  const processingTimeRemaining = document.getElementById('processing-time-remaining');

  let processingStartTime = 0;

  function showProcessingModal() {
    processingStartTime = Date.now();
    if (processingProgressBar) processingProgressBar.style.width = '5%';
    if (processingPercentText) processingPercentText.textContent = '5%';
    if (processingPhaseText) processingPhaseText.textContent = 'Preparing audio recording…';
    if (processingTimeRemaining) processingTimeRemaining.textContent = 'Estimating time…';
    if (modalProcessing) {
      modalProcessing.classList.remove('hidden');
    }
  }

  function hideProcessingModal() {
    if (modalProcessing) {
      modalProcessing.classList.add('hidden');
    }
  }

  function updateProcessingModal({ percent, phase, timeRemaining } = {}) {
    if (percent !== undefined && processingProgressBar) {
      const clamped = Math.max(0, Math.min(100, Math.round(percent)));
      processingProgressBar.style.width = `${clamped}%`;
      if (processingPercentText) processingPercentText.textContent = `${clamped}%`;
    }
    if (phase && processingPhaseText) {
      processingPhaseText.textContent = phase;
    }
    if (timeRemaining !== undefined && processingTimeRemaining) {
      processingTimeRemaining.textContent = timeRemaining;
    }
  }


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
    if (mediaSession.activeAudioSource !== 'browser') return;
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
    ? (configStore.get('ui.persist_transcript') !== false)
    : (typeof localStorage !== 'undefined' ? localStorage.getItem('teleprompter_persist_transcript') !== 'false' : true);
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
      const activeText = (transcriptInput && transcriptInput.value)
        || (scriptEditor && scriptEditor.modalInput && scriptEditor.modalInput.value)
        || '';
      if (activeText && activeText.trim()) {
        if (transcriptInput && transcriptInput.value !== activeText) {
          transcriptInput.value = activeText;
        }
        if (configStore) configStore.set('script.saved_transcript', activeText);
        localStorage.setItem('teleprompter_saved_transcript', activeText);
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
      if (scriptEditor) {
        scriptEditor.syncFromSource();
      }
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
    if (persistTranscript) {
      const activeText = (transcriptInput && transcriptInput.value)
        || (scriptEditor && scriptEditor.modalInput && scriptEditor.modalInput.value)
        || '';
      if (activeText && activeText.trim()) {
        if (configStore) configStore.set('script.saved_transcript', activeText);
        localStorage.setItem('teleprompter_saved_transcript', activeText);
      }
    }
  });

  function showToast(el, msg, durationMs = 2000) {
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('opacity-0');
    el.classList.add('opacity-100');
    setTimeout(() => {
      el.classList.remove('opacity-100');
      el.classList.add('opacity-0');
    }, durationMs);
  }

  function showFormatToast(msg = 'Formatted ✓') {
    showToast(formatToast, msg, 2000);
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

  // ---- Rehearsal Cues & Vocabulary Subsystem (static/cues.js) ---------------
  const cues = new TeleprompterCues.RehearsalCues({
    configStore: configStore,
    storage: typeof localStorage !== 'undefined' ? localStorage : null,
    onChange: () => {
      if (allWords && allWords.length > 0) {
        parseAndRenderTranscript();
      }
    },
  });
  cues.bindUI();

  // ---- Audio Source Selection & Recording Mode / Format UI (Delegated to MediaSession) ----
  mediaSession.bindUI({
    optAudioSource,
    audioSourceBadge,
    audioSourceDesc,
    vuSource,
    btnRefreshAudioDevices,
    optRecordMode,
    optRecordFormat,
    recordingFormatGroup,
    formatDesc
  }, {
    onDeviceSelect: async (devId, targetName) => {
      send({ type: 'set_audio_device', device: devId });
      await switchBrowserAudio(targetName);
      if (devId === 'browser') {
        if (isPrompting) startBrowserAudioStream();
      } else {
        stopBrowserAudioStream();
      }
    },
    onRefreshDevices: async () => {
      send({ type: 'refresh_audio_devices' });
      await switchBrowserAudio(mediaSession.activeAudioSourceName);
    },
    onFormatChange: () => {
      updateStopButtonText();
    }
  });

  function updateStopButtonText() {
    if (!btnStop) return;
    const isHidden = btnStop.classList.contains('hidden') || !isPrompting;
    if (isRehearsal) {
      btnStop.textContent = 'Finish Rehearsal';
      btnStop.className = 'px-4 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold rounded shadow transition cursor-pointer' + (isHidden ? ' hidden' : '');
      return;
    }
    btnStop.className = 'px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-semibold rounded shadow transition cursor-pointer' + (isHidden ? ' hidden' : '');
    const mode = mediaSession.activeRecordMode || 'video';
    if (mode === 'audio') {
      const fmt = (mediaSession.activeAudioFormat || 'mp3').toUpperCase();
      btnStop.textContent = `Stop & Save Audio (${fmt})`;
    } else if (mode === 'video') {
      const fmt = (mediaSession.activeVideoFormat || 'mp4').toUpperCase();
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
      if (serverStatusPill) {
        serverStatusPill.textContent = 'Online';
        serverStatusPill.className = 'text-[10px] px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 font-mono border border-emerald-700/50';
      }
      if (serverControl && serverControl.isRestarting) {
        serverControl.handleReconnected();
      }
      const savedEngine = localStorage.getItem('teleprompter_engine_speed');
      if (savedEngine) {
        send({ type: 'set_engine', mode: savedEngine });
      }
      updateStartButton();
    };
    ws.onclose = () => {
      wsConnected = false;
      updateStartButton();
      const isOffline = serverControl ? serverControl.isShutDown : false;
      const isRestarting = serverControl ? serverControl.isRestarting : false;
      if (serverStatusPill) {
        serverStatusPill.textContent = isOffline ? 'Offline' : (isRestarting ? 'Restarting' : 'Reconnecting');
        serverStatusPill.className = isOffline
          ? 'text-[10px] px-1.5 py-0.5 rounded bg-red-950 text-red-400 font-mono border border-red-700/50'
          : 'text-[10px] px-1.5 py-0.5 rounded bg-amber-950 text-amber-400 font-mono border border-amber-700/50';
      }
      if (isOffline) {
        setBadge(wsStatus, 'offline', 'bg-red-950 text-red-400 border-red-500/30');
        return;
      }
      setBadge(wsStatus, isRestarting ? 'restarting…' : 'reconnecting…', 'bg-yellow-950 text-yellow-400 border-yellow-500/30');
      setTimeout(connect, 1500);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleMessage(msg);
    };
  }

  // ---- Post-recording boundary refinement ----------------------------------
  // After Stop, the decoded recording is sent to the server, which transcribes the
  // whole file (word timestamps) and reports when each script section was really
  // spoken. Resolves to a { sectionId: {startSec,endSec}|null } map, or null on any
  // failure/timeout so the caller keeps the live-tracked boundaries.
  const pendingRefines = new Map();

  function requestRefinedBoundaries(audioBuffer, sections, onRefineProgress) {
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !audioBuffer || !sections || sections.length === 0) {
        return resolve(null);
      }
      const reqId = 'refine-' + Date.now();
      const durationSec = audioBuffer.duration || 0;
      // Generous but bounded: long takes need longer to transcribe on CPU.
      const timeoutMs = Math.min(600, Math.max(60, durationSec * 2)) * 1000;
      const timer = setTimeout(() => {
        pendingRefines.delete(reqId);
        console.warn('[REFINE] Timed out waiting for server; using live boundaries.');
        resolve(null);
      }, timeoutMs);

      const entry = {
        resolve: (msg) => {
          clearTimeout(timer);
          pendingRefines.delete(reqId);
          resolve(msg && msg.ok ? msg.boundaries : null);
        },
        onProgress: (msg) => {
          if (typeof onRefineProgress === 'function') {
            onRefineProgress(msg);
          }
        }
      };
      pendingRefines.set(reqId, entry);

      try {
        const pcm = TeleprompterMedia.audioBufferToPcm16k(audioBuffer);
        const CHUNK_SAMPLES = 150000; // ~300 KB raw, ~400 KB base64: under the 2 MB limit
        let seq = 0;
        for (let off = 0; off < pcm.length; off += CHUNK_SAMPLES) {
          const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset + off * 2,
            Math.min(CHUNK_SAMPLES, pcm.length - off) * 2);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          }
          // "type" first: the server recognises refine messages from the start of the frame.
          ws.send(JSON.stringify({ type: 'refine_chunk', id: reqId, seq: seq++, data: btoa(bin) }));
        }
        const sectionTexts = sections.map((s) => ({
          id: s.id,
          text: allWords.filter((w) => w.sectionId === s.id).map((w) => w.original).join(' '),
          retakeSec: (s.retakeSec !== null && s.retakeSec !== undefined && !isNaN(Number(s.retakeSec)))
            ? Number(s.retakeSec)
            : null,
        }));
        ws.send(JSON.stringify({ type: 'refine_end', id: reqId, sections: sectionTexts }));
      } catch (err) {
        console.warn('[REFINE] Upload failed:', err);
        clearTimeout(timer);
        pendingRefines.delete(reqId);
        resolve(null);
      }
    });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'refine_progress': {
        const entry = pendingRefines.get(msg.id);
        if (entry && typeof entry.onProgress === 'function') {
          entry.onProgress(msg);
        }
        break;
      }
      case 'refine_result': {
        const entry = pendingRefines.get(msg.id);
        if (entry) {
          if (typeof entry === 'function') entry(msg);
          else if (typeof entry.resolve === 'function') entry.resolve(msg);
        }
        break;
      }
      case 'config':
        browserAudio = !!msg.browser_audio;
        if (msg.config && configStore) {
          configStore.reconcileServerConfig(msg.config);
          const activeClientText = (transcriptInput && transcriptInput.value && transcriptInput.value.trim())
            || (scriptEditor && scriptEditor.modalInput && scriptEditor.modalInput.value && scriptEditor.modalInput.value.trim())
            || '';

          if (persistTranscript && !activeClientText) {
            const recovered = configStore.get('script.saved_transcript');
            if (recovered && recovered.trim()) {
              transcriptInput.value = recovered;
              if (scriptEditor) scriptEditor.syncFromSource();
              updateClearButtonVisibility();
              parseAndRenderTranscript();
              updateStartButton();
            }
          } else if (persistTranscript && activeClientText) {
            const serverScript = msg.config.script && msg.config.script.saved_transcript;
            if (serverScript !== activeClientText) {
              send({ type: 'config_patch', domain: 'script', data: { saved_transcript: activeClientText } });
            }
          }
        }
        if (msg.profile) {
          const saved = configStore ? configStore.get('engine.profile') : localStorage.getItem('teleprompter_engine_speed');
          if (!saved) updateEngineUI(msg.profile);
        }
        if (msg.audio_devices) {
          const savedDev = configStore ? configStore.get('audio.device_id') : localStorage.getItem('teleprompter_audio_device');
          const activeDev = savedDev || (msg.browser_audio ? 'browser' : msg.active_audio_device) || 'browser';
          mediaSession.updateAudioSourceUI(activeDev, msg.audio_devices);
          const matchedDev = (msg.audio_devices || []).find((d) => String(d.id) === String(activeDev));
          const targetName = matchedDev ? (matchedDev.raw_name || matchedDev.name) : mediaSession.activeAudioSourceName;
          if (targetName) {
            mediaSession.activeAudioSourceName = targetName;
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
        if (mediaSession.activeAudioSource === 'browser' && isPrompting) {
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
        mediaSession.updateAudioSourceUI(msg.device);
        const switchedDev = mediaSession.availableAudioDevices.find((d) => String(d.id) === String(msg.device));
        if (switchedDev) {
          const tName = switchedDev.raw_name || switchedDev.name;
          mediaSession.activeAudioSourceName = tName;
          localStorage.setItem('teleprompter_audio_device_name', tName);
          switchBrowserAudio(tName);
        }
        break;
      case 'vu':
        if (Date.now() - mediaSession.lastLocalLevelTime > 150) {
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
      case 'server_stopping':
        if (serverControl) {
          serverControl.handleServerStopping(msg.action);
        }
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
    cues.recordFumbles(incoming, (f) => {
      const wordEl = document.getElementById(`w-${f.index}`);
      if (wordEl) {
        const cue = cues.getCue(f.word || f.clean);
        if (cue.classes) {
          wordEl.className = `prompter-word ${cue.classes}`;
        }
      }
    });
    cues.renderRehearsalTags();
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
    if (msg.active_audio_device && !mediaSession.availableAudioDevices.length) {
      mediaSession.updateAudioSourceUI(msg.active_audio_device);
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
        if (mediaSession.activeRecordMode === 'off' || !mediaSession.mediaRecorder || mediaSession.mediaRecorder.state === 'inactive') {
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
      if (mediaSession.activeAudioSource === 'browser' && isPrompting) {
        stopBrowserAudioStream();
        startBrowserAudioStream();
      }
    } catch (err) {
      console.warn('Microphone access / switch warning:', err);
    }
  }

  async function initAudio() {
    const target = mediaSession.activeAudioSourceName || (mediaSession.activeAudioSource !== 'browser' ? mediaSession.activeAudioSource : null);
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
    if (mediaSession.activeAudioSource !== 'browser') return;
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

  // ---- PrompterViewport Display Engine (static/viewport.js) ----------------
  const viewport = new TeleprompterViewport.PrompterViewport({
    linesContainer: linesContainer,
    scrollingContent: scrollingContent,
    viewingWindow: viewingWindow,
    cursorBar: cursorBar,
    initialFontSize: optFontsize ? parseInt(optFontsize.value, 10) || 25 : 25,
    activeLineOffset: 1,
  });

  function getLineHeightForFontSize(fontSize) {
    return TeleprompterViewport.getLineHeightForFontSize(fontSize);
  }

  let currentLineHeight = viewport.lineHeight;

  optFontsize.addEventListener('input', (e) => {
    const newSize = parseInt(e.target.value, 10);
    document.getElementById('val-fontsize').textContent = `${newSize}px`;
    currentLineHeight = viewport.setFontSize(newSize, parseInt(optLines.value, 10));
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
    viewport.updateViewportLines(numLines);
  });

  function updateViewportLines(numLines) {
    viewport.updateViewportLines(numLines);
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
        if (scriptEditor) {
          scriptEditor.syncFromSource();
        }
        saveTranscriptIfEnabled();
        parseAndRenderTranscript();
        updateStartButton();
      }, 0);
      return;
    }
    setTimeout(() => {
      if (!transcriptInput.value.trim()) return;
      const formatted = formatScriptForPrompter(transcriptInput.value);
      transcriptInput.value = formatted;
      if (scriptEditor) {
        scriptEditor.syncFromSource();
      }
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
      if (scriptEditor) {
        scriptEditor.syncFromSource();
      }
      saveTranscriptIfEnabled();
      parseAndRenderTranscript();
      updateStartButton();
    } catch (err) {
      alert('Could not read file: ' + err.message);
    }
  });

  transcriptInput.addEventListener('input', () => {
    if (scriptEditor) {
      scriptEditor.syncFromSource();
    }
    saveTranscriptIfEnabled();
    parseAndRenderTranscript();
    updateStartButton();
  });

  // ---- Script Editor Subsystem ----------------------------------------------
  try {
    const ScriptEditorClass = (typeof TeleprompterScriptEditor !== 'undefined')
      ? (TeleprompterScriptEditor.TeleprompterScriptEditor || TeleprompterScriptEditor)
      : null;
    scriptEditor = (ScriptEditorClass && transcriptInput)
      ? new ScriptEditorClass({
          sourceInput: transcriptInput,
          fileInput: fileInput,
          formatFn: (text) => (typeof formatScriptForPrompter === 'function' ? formatScriptForPrompter(text) : text),
          getAutoFormatEnabled: () => autoFormatOnPaste,
          onSync: () => {
            saveTranscriptIfEnabled();
            updateClearButtonVisibility();
            parseAndRenderTranscript();
            updateStartButton();
          },
          onClear: () => {
            if (persistTranscript) {
              if (configStore) configStore.set('script.saved_transcript', '');
              localStorage.removeItem('teleprompter_saved_transcript');
            }
            updateClearButtonVisibility();
            parseAndRenderTranscript();
            updateStartButton();
          }
        })
      : null;
  } catch (err) {
    console.error('[Teleprompter] Failed to initialize ScriptEditor modal:', err);
    scriptEditor = null;
  }

  // External / legacy compatibility helpers
  function openScriptModal() { if (scriptEditor) scriptEditor.open(); }
  function closeScriptModal() { if (scriptEditor) scriptEditor.close(); }
  function updateModalStats() { if (scriptEditor) scriptEditor.updateStats(); }
  function showModalScriptToast(msg = 'Saved & Applied ✓') { if (scriptEditor) scriptEditor.showToast(msg); }

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
    // Rebuild SectionTimeline whenever parsedSections is repopulated
    sectionTimeline = new TeleprompterTimeline.SectionTimeline(
      parsedSections,
      () => (Date.now() - sessionStartTime) / 1000,
      { onActiveSectionChange: updateRetakeButtonLabel, minDwellSec: 2.0 }
    );

    if (linesData.length === 0 || allWords.length === 0) {
      viewport.renderScript([]);
      currentWordIndex = 0;
      currentLineIndex = 0;
      return;
    }

    viewport.renderScript(linesData, cues);
    currentWordIndex = 0;
    currentLineIndex = 0;
    updateHighlighting(0);
    if (parsedSections.length > 0 && btnRetakeText) {
      btnRetakeText.textContent = `Re-take [${parsedSections[0].title}]`;
    }
  }

  // ---- Highlighting & scrolling --------------------------------------------
  function updateHighlighting(wordIndex, isManual = false) {
    if (!allWords.length) return;

    const res = viewport.highlightWord(wordIndex, allWords);
    if (!res || !res.activeWordObj) return;

    currentWordIndex = wordIndex;
    currentLineIndex = res.lineIdx;

    if (parsedSections.length > 0 && res.activeWordObj.sectionId) {
      handleSectionWordProgress(res.activeWordObj, isManual);
    }
  }

  // ---- Section Timeline & Retake (static/timeline.js) -----------------------
  function updateRetakeButtonLabel(cur) {
    if (btnRetakeText && cur) {
      btnRetakeText.textContent = `Re-take [${cur.title}]`;
    }
  }

  let sectionTimeline = new TeleprompterTimeline.SectionTimeline(
    parsedSections,
    () => (Date.now() - sessionStartTime) / 1000,
    { onActiveSectionChange: updateRetakeButtonLabel, minDwellSec: 2.0 }
  );

  // ---- Thin adapters (preserve external call sites unchanged) ---------------
  function handleSectionWordProgress(targetWord, isManual = false) {
    sectionTimeline.wordSeen(targetWord, isPrompting, isManual);
    currentActiveSectionId = sectionTimeline.activeId;
  }

  function triggerSectionRetake() {
    if (!isPrompting || parsedSections.length === 0) return;
    const nowSec = (mediaSession && typeof mediaSession.elapsedSec === 'number')
      ? mediaSession.elapsedSec
      : (sectionTimeline ? sectionTimeline.elapsedSec : 0);

    // Resolve target section from the current word the prompter is positioned on
    const currentWord = (allWords && currentWordIndex >= 0 && currentWordIndex < allWords.length)
      ? allWords[currentWordIndex]
      : null;
    const targetRef = currentWord ? (currentWord.sectionId || currentWordIndex) : currentWordIndex;

    const result = sectionTimeline.retake(nowSec, targetRef);
    if (!result) return;

    currentWordIndex = result.seekIndex;
    currentActiveSectionId = result.id;

    // Positional-only rewind to the start of the retaken section.
    // Temporarily gate isPrompting so updateHighlighting skips premature timestamp mutation
    // until the speaker actually starts speaking.
    const _wasPrompting = isPrompting;
    isPrompting = false;
    updateHighlighting(currentWordIndex, true);
    isPrompting = _wasPrompting;

    send({ type: 'seek', word_index: currentWordIndex });

    setBadge(vadStatus, 'RE-TAKE READY', 'bg-amber-950 text-amber-300 border-amber-500/40');
    speechHud.textContent = `Re-taking [${result.title}]… speak from line start.`;
  }

  if (btnRetake) {
    btnRetake.addEventListener('click', triggerSectionRetake);
  }

  // ---- Start / Rehearse / Stop -----------------------------------------------
  async function startSession(rehearsal = false) {
    if (isPrompting) return;
    if (!transcriptInput.value.trim()) return;

    try {
      parseAndRenderTranscript();
      currentWordIndex = 0;
      isPrompting = true;
      isRehearsal = rehearsal;

      if (!rehearsal) {
        mediaSession.activeRecordMode = optRecordMode ? optRecordMode.value : 'video';
      }
      mediaSession.setControlsDisabled(true);

      if (!mediaSession.audioStream || !mediaSession.audioStream.active || !mediaSession.audioStream.getAudioTracks().some((t) => t.readyState === 'live')) {
        await initAudio();
      }
      await mediaSession.ensureAudioContext();

      if (mediaSession.activeAudioSource === 'browser') {
        startBrowserAudioStream();
      }

      if (!rehearsal && mediaSession.activeRecordMode !== 'off') {
        try {
          console.log('[DEBUG START] Starting recording. mode:', mediaSession.activeRecordMode, 'audioFormat:', mediaSession.activeAudioFormat, 'videoFormat:', mediaSession.activeVideoFormat);
          await mediaSession.startRecording();
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

      const sectionBoundaries = parsedSections.map((s) => s.startIndex).filter((n) => n !== null && n !== undefined);
      const startPayload = {
        type: 'start',
        words: allWords.map((w) => w.original),
        section_boundaries: sectionBoundaries,
        wpm: 140,
        audio_device: mediaSession.activeAudioSource
      };
      if (rehearsal) {
        startPayload.rehearsal = true;
      }
      send(startPayload);

      if (!rehearsal) {
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
      }

      // Hide the re-open button while a new session is active
      if (btnReopenExport) {
        btnReopenExport.classList.add('hidden');
        btnReopenExport.classList.remove('flex');
      }
      updateStopButtonText();
      btnStart.classList.add('hidden');
      if (btnRehearse) btnRehearse.classList.add('hidden');
      btnStop.classList.remove('hidden');
      // Positional-only scroll-to-word-0 at session start.
      // Must NOT stamp sectionTimeline timestamps — the speaker hasn't uttered a word yet.
      // Temporarily gate isPrompting so wordSeen() skips all timestamp mutations.
      const _wasPrompting = isPrompting;
      isPrompting = false;
      updateHighlighting(0);
      isPrompting = _wasPrompting;
      updateStartButton();

      if (rehearsal) {
        setBadge(vadStatus, 'REHEARSAL (CATCHING FUMBLES)', 'bg-emerald-950 text-emerald-400 border-emerald-500/30');
        speechHud.textContent = 'Trial read-through: read naturally. Skipped, stumbled, or repeated words will be caught!';
      } else {
        setBadge(vadStatus, 'LISTENING (LOCAL WHISPER)', 'bg-indigo-950 text-indigo-400 border-indigo-500/30');
        if (recIndicator.classList.contains('hidden') && mediaSession.activeRecordMode !== 'off') {
          speechHud.textContent = 'Speech sync listening, but recording is inactive (check camera/mic permissions).';
        } else {
          speechHud.textContent = 'Speak into the mic to scroll in sync…';
        }
      }
    } catch (err) {
      isPrompting = false;
      isRehearsal = false;
      mediaSession.setControlsDisabled(false);
      updateStartButton();
      speechHud.textContent = `⚠ Error starting ${rehearsal ? 'rehearsal' : 'session'}: ` + (err && err.message ? err.message : String(err));
      setBadge(vadStatus, 'ERROR', 'bg-red-950 text-red-400 border-red-500/30');
    }
  }

  if (btnRehearse) {
    btnRehearse.addEventListener('click', () => startSession(true));
  }
  btnStart.addEventListener('click', () => startSession(false));

  let isStopping = false;

  btnStop.addEventListener('click', () => {
    if (isStopping || !isPrompting) {
      return;
    }
    isStopping = true;
    console.log('[DEBUG STOP] clicked. activeRecordMode:', mediaSession.activeRecordMode, 'mediaRecorder:', mediaSession.mediaRecorder ? mediaSession.mediaRecorder.state : 'null');

    // Immediate visual feedback so the user knows Stop has registered
    btnStop.disabled = true;
    setBadge(vadStatus, 'FINALIZING…', 'bg-yellow-950 text-yellow-400 border-yellow-500/30');
    speechHud.textContent = 'Finalizing takes and speech alignment…';

    // Stop streaming new audio frames from the browser mic immediately so no trailing silence/noise is sent
    stopBrowserAudioStream();

    if (btnRetake) {
      btnRetake.classList.add('hidden');
      btnRetake.classList.remove('flex');
    }

    // Flush window (1200ms): allow in-flight Whisper recognition results (600ms CPU tick + 500ms margin)
    // and sync messages to update active section transitions before sealing boundaries.
    const FLUSH_DELAY_MS = 1200;
    setTimeout(() => {
      isPrompting = false;
      isStopping = false;
      btnStop.disabled = false;

      mediaSession.setControlsDisabled(false);

      const sessionEndTime = Date.now();
      const totalSessionSec = (sessionEndTime - sessionStartTime) / 1000;
      // Close the active section via SectionTimeline (C1) and resolve fallback boundaries (Step 2)
      sectionTimeline.close(totalSessionSec);
      sectionTimeline.resolveBoundaries(totalSessionSec);

      // ── [DIAG] Section Boundary Dump ────────────────────────────────────────
      // Paste the console output from here into chat to diagnose boundary issues.
      // Remove this block once the take slicing is confirmed correct.
      try {
        const markers = sectionTimeline.getSectionMarkers();
        console.group('[DIAG] Section boundaries at Stop (totalSessionSec=' + totalSessionSec.toFixed(3) + 's)');
        markers.forEach((s, i) => {
          const dur = (s.startSec !== null && s.endSec !== null)
            ? (s.endSec - s.startSec).toFixed(3) + 's'
            : 'N/A';
          console.log(
            `  [${i + 1}] id=${s.id}  title="${s.title}"` +
            `  startSec=${s.startSec !== null ? s.startSec.toFixed(3) : 'null'}` +
            `  endSec=${s.endSec !== null ? s.endSec.toFixed(3) : 'null'}` +
            `  _lastSeenSec=${s._lastSeenSec !== null ? Number(s._lastSeenSec).toFixed(3) : 'null'}` +
            `  duration=${dur}`
          );
        });
        console.groupEnd();
      } catch (_diagErr) { /* never block the stop flow */ }
      // ── end [DIAG] ──────────────────────────────────────────────────────────
      currentActiveSectionId = null;

      send({ type: 'stop' });

      if (mediaSession.activeRecordMode !== 'off' && mediaSession.mediaRecorder && mediaSession.mediaRecorder.state !== 'inactive') {
        const willProcessTakes = (mediaSession.activeRecordMode === 'audio' || !mediaSession.hasRecordedVideoTrack)
          && (mediaSession.activeAudioFormat === 'wav' || mediaSession.activeAudioFormat === 'mp3')
          && sectionTimeline.getSectionMarkers().length > 0;

        if (willProcessTakes) {
          showProcessingModal();
        }

        const handleRefineProgress = (msg) => {
          if (!msg || !msg.total) return;
          const currentSec = Math.min(msg.total, Math.max(0, Number(msg.current) || 0));
          const totalSec = Number(msg.total) || 1;
          const progressFrac = currentSec / totalSec;
          // Scale Whisper transcription progress to 15% - 80% of overall bar
          const pct = Math.round(15 + progressFrac * 65);
          const elapsedSec = (Date.now() - processingStartTime) / 1000;
          let timeEst = 'Estimating…';
          if (progressFrac > 0.05 && elapsedSec > 0.3) {
            const totalEstimatedTime = elapsedSec / progressFrac;
            const remainingSec = Math.max(0, totalEstimatedTime - elapsedSec);
            // Add ~1.5s for slicing and encoding
            const totalRemaining = Math.ceil(remainingSec + 1.5);
            timeEst = totalRemaining > 1 ? `~${totalRemaining}s remaining` : 'Almost done…';
          }
          updateProcessingModal({
            percent: pct,
            phase: `Transcribing audio (${Math.round(currentSec)}s / ${Math.round(totalSec)}s)…`,
            timeRemaining: timeEst
          });
        };

        console.log('[DEBUG STOP] Calling mediaSession.stopRecording...');
        mediaSession.stopRecording({
          sections: sectionTimeline.getSectionMarkers(),
          sessionDurationSec: totalSessionSec,
          refineBoundaries: (buf, secs, progCb) => requestRefinedBoundaries(buf, secs, (msg) => {
            handleRefineProgress(msg);
            if (typeof progCb === 'function') progCb(msg);
          }),
          onProgress: (prog) => {
            console.log('[DEBUG STOP] Progress:', prog);
            if (typeof prog === 'string') {
              updateProcessingModal({ phase: prog });
              setBadge(vadStatus, 'ENCODING…', 'bg-yellow-950 text-yellow-400 border-yellow-500/30');
              speechHud.textContent = prog;
            } else if (prog && typeof prog === 'object') {
              updateProcessingModal({
                percent: prog.percent,
                phase: prog.text || prog.phase,
                timeRemaining: prog.timeRemaining
              });
              setBadge(vadStatus, 'ENCODING…', 'bg-yellow-950 text-yellow-400 border-yellow-500/30');
              if (prog.text) speechHud.textContent = prog.text;
            }
          }
        }).then(async (result) => {
          hideProcessingModal();
          console.log('[DEBUG STOP] stopRecording resolved with:', result);
          if (!result) return;
          const { blob, extension, filename, takes } = result;

          if (!blob || blob.size === 0) {
            setBadge(vadStatus, 'STOPPED', 'bg-gray-800 text-gray-400 border-gray-700');
            speechHud.textContent = 'Recording ended (no audio/video frames captured). Check microphone & camera permissions in Brave.';
            return;
          }

          const effectiveMode = (mediaSession.activeRecordMode === 'audio' || !mediaSession.hasRecordedVideoTrack) ? 'audio' : 'video';
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
          hideProcessingModal();
          console.error('Error saving recording:', err);
          setBadge(vadStatus, 'ERROR', 'bg-red-950 text-red-400 border-red-500/30');
          speechHud.textContent = '⚠ Error saving recording: ' + (err && err.message ? err.message : String(err));
        });
      } else {
        if (isRehearsal) {
          setBadge(vadStatus, 'REHEARSAL COMPLETE', 'bg-emerald-950 text-emerald-400 border-emerald-500/30');
          const count = cues.rehearsalWordsList.length;
          speechHud.textContent = `Trial complete! ${count} fumbled ${count === 1 ? 'word' : 'words'} highlighted for your live take.`;
        } else {
          setBadge(vadStatus, 'STOPPED', 'bg-gray-800 text-gray-400 border-gray-700');
          speechHud.textContent = mediaSession.activeRecordMode === 'off'
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
    }, FLUSH_DELAY_MS);
  });

  // ---- Keyboard manual stepping & Hotkeys ---------------------------------
  window.addEventListener('keydown', (e) => {
    // 1. Modal dismissals (Escape key)
    if (e.key === 'Escape') {
      if (scriptEditor && scriptEditor.isOpen()) {
        scriptEditor.close();
        return;
      }
      if (cues && cues.isOpen()) {
        cues.closeModal();
        return;
      }
      if (serverControl && serverControl.isOpen() && serverControl.canDismiss()) {
        serverControl.close();
        return;
      }
      return;
    }

    // 2. Script Editor shortcut (Cmd/Ctrl + E)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      if (scriptEditor && scriptEditor.isOpen()) {
        e.preventDefault();
        scriptEditor.close();
      } else if (activeTag !== 'input' || document.activeElement === transcriptInput) {
        e.preventDefault();
        if (scriptEditor) scriptEditor.open();
      }
      return;
    }

    // 3. Navigation & Hotkeys (ignore when typing in inputs/textareas)
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
      updateHighlighting(currentWordIndex, true);
      send({ type: 'seek', word_index: currentWordIndex });
    } else if (e.code === 'ArrowUp' && allWords.length) {
      currentWordIndex = Math.max(0, currentWordIndex - 1);
      updateHighlighting(currentWordIndex, true);
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
        updateHighlighting(idx, true);
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

  if (btnClearHighlights) {
    btnClearHighlights.addEventListener('click', () => {
      if (speechHud && !isPrompting) {
        speechHud.textContent = 'Rehearsal fumble highlights cleared.';
      }
    });
  }

  // ---- Export Modal & Delivery Subsystem ------------------------------------
  let exportSession = null;
  try {
    exportSession = (typeof TeleprompterExport !== 'undefined')
      ? TeleprompterExport.init({
          modalEl: document.getElementById('modal-export'),
          takesList: document.getElementById('export-takes-list'),
          summaryEl: document.getElementById('export-summary-text'),
          badgeEl: document.getElementById('export-mode-badge'),
          speechHudEl: speechHud,
          createZipFn: (files) => (typeof TeleprompterMedia !== 'undefined' && TeleprompterMedia.createZipBlob ? TeleprompterMedia.createZipBlob(files) : Promise.reject(new Error('Zip unavailable'))),
        })
      : null;
  } catch (err) {
    console.error('[Teleprompter] Failed to initialize Export modal:', err);
    exportSession = null;
  }

  // Last export result — persisted so the user can re-open the modal after closing it.
  let _lastExportResult = null;
  const btnReopenExport = document.getElementById('btn-reopen-export');

  function openExportModal(takes, mode, format) {
    if (!exportSession) return;
    // Cache for re-open button
    _lastExportResult = { takes, mode, format };
    if (btnReopenExport) {
      btnReopenExport.classList.remove('hidden');
      btnReopenExport.classList.add('flex');
    }
    exportSession.open(takes, mode, format);
  }
  function closeExportModal() { if (exportSession) exportSession.close(); }

  if (btnReopenExport) {
    btnReopenExport.addEventListener('click', () => {
      if (_lastExportResult && exportSession) {
        const { takes, mode, format } = _lastExportResult;
        exportSession.open(takes, mode, format);
      }
    });
  }

  // ---- Server Control Subsystem ---------------------------------------------
  try {
    const ServerControlClass = (typeof TeleprompterServerControl !== 'undefined')
      ? (TeleprompterServerControl.TeleprompterServerControl || TeleprompterServerControl)
      : null;
    serverControl = (ServerControlClass && modalServerAction)
      ? new ServerControlClass({
          modalEl: modalServerAction,
          iconEl: serverActionIcon,
          titleEl: serverActionTitle,
          descEl: serverActionDesc,
          footerEl: serverActionFooter,
          btnRestartTrigger: btnRestartServer,
          btnShutdownTrigger: btnShutdownServer,
          serverStatusPill,
          onRestart: () => send({ type: 'restart_server' }),
          onShutdown: () => send({ type: 'shutdown_server' }),
          onToast: (msg) => showFormatToast(msg),
        })
      : null;
  } catch (err) {
    console.error('[Teleprompter] Failed to initialize ServerControl modal:', err);
    serverControl = null;
  }

  document.getElementById('btn-toggle-panel').addEventListener('click', () => {
    document.getElementById('side-panel').classList.toggle('hidden');
  });

  // ---- Boot ------------------------------------------------------------------
  try {
    if (optFontsize) {
      const initialFontSize = parseInt(optFontsize.value, 10) || 25;
      currentLineHeight = viewport.setFontSize(initialFontSize, parseInt(optLines.value, 10));
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
      const savedTranscript = (configStore && configStore.get('script.saved_transcript'))
        || (typeof localStorage !== 'undefined' ? localStorage.getItem('teleprompter_saved_transcript') : '')
        || '';
      if (savedTranscript && (!transcriptInput.value || !transcriptInput.value.trim())) {
        transcriptInput.value = savedTranscript;
      }
      if (scriptEditor) {
        scriptEditor.syncFromSource();
      }
    }
    updateClearButtonVisibility();
    parseAndRenderTranscript();
    initCameraAndAudio();
    updateViewportLines(parseInt(optLines.value, 10));
    connect();
  } catch (err) {
    console.error('[Teleprompter] Error during boot sequence:', err);
  }
})();