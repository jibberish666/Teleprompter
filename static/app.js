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
  const linesContainer = document.getElementById('lines-container');
  const scrollingContent = document.getElementById('scrolling-content');
  const prompterBox = document.getElementById('prompter-box');
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const vadStatus = document.getElementById('vad-status');
  const wsStatus = document.getElementById('ws-status');
  const speechHud = document.getElementById('speech-hud');
  const recIndicator = document.getElementById('rec-indicator');
  const vuBar = document.getElementById('vu-bar');
  const vuText = document.getElementById('vu-text');

  const optOpacity = document.getElementById('opt-opacity');
  const optFontsize = document.getElementById('opt-fontsize');
  const optSens = document.getElementById('opt-sens');
  const optMirror = document.getElementById('opt-mirror');
  const optLines = document.getElementById('opt-lines');
  const valLines = document.getElementById('val-lines');
  const viewingWindow = document.getElementById('viewing-window');
  const cursorBar = document.getElementById('cursor-bar');
  const optRecordMode = document.getElementById('opt-record-mode');

  let activeRecordMode = 'video';
  let activeRecordingOptions = { mimeType: '', extension: 'webm' };

  function getAudioRecorderOptions() {
    const mimeTypes = [
      { mime: 'audio/webm;codecs=opus', ext: 'webm' },
      { mime: 'audio/webm', ext: 'webm' },
      { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
      { mime: 'audio/mp4', ext: 'm4a' },
      { mime: 'audio/aac', ext: 'm4a' }
    ];
    if (window.MediaRecorder && typeof MediaRecorder.isTypeSupported === 'function') {
      for (const item of mimeTypes) {
        if (MediaRecorder.isTypeSupported(item.mime)) {
          return { mimeType: item.mime, extension: item.ext };
        }
      }
    }
    return { mimeType: '', extension: 'webm' };
  }

  function getVideoRecorderOptions() {
    const mimeTypes = [
      { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
      { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
      { mime: 'video/webm', ext: 'webm' },
      { mime: 'video/mp4', ext: 'mp4' }
    ];
    if (window.MediaRecorder && typeof MediaRecorder.isTypeSupported === 'function') {
      for (const item of mimeTypes) {
        if (MediaRecorder.isTypeSupported(item.mime)) {
          return { mimeType: item.mime, extension: item.ext };
        }
      }
    }
    return { mimeType: '', extension: 'webm' };
  }

  function updateStopButtonText() {
    const mode = optRecordMode ? optRecordMode.value : 'video';
    if (mode === 'audio') {
      btnStop.textContent = 'Stop & Save Audio';
    } else if (mode === 'video') {
      btnStop.textContent = 'Stop & Save Video';
    } else {
      btnStop.textContent = 'Stop Session';
    }
  }

  if (optRecordMode) {
    optRecordMode.addEventListener('change', updateStopButtonText);
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
        if (browserAudio && audioContext && audioContext.state === 'running') {
          startBrowserAudioStream();
        }
        break;
      case 'status':
        onStatus(msg);
        break;
      case 'sync':
        onSync(msg);
        break;
      case 'error':
        speechHud.textContent = '⚠ ' + msg.message;
        setBadge(vadStatus, 'ERROR', 'bg-red-950 text-red-400 border-red-500/30');
        break;
      default:
        break;
    }
  }

  function onStatus(msg) {
    if (typeof msg.ready === 'boolean') {
      modelReady = msg.ready;
      if (modelReady) {
        const src = browserAudio ? 'browser-audio' : (msg.source || 'sounddevice');
        setBadge(vadStatus, 'OFFLINE ENGINE READY', 'bg-green-950 text-green-400 border-green-500/30');
        speechHud.textContent = 'Local Whisper ready. Paste a script and Start.';
      } else {
        setBadge(vadStatus, 'LOADING MODEL…', 'bg-indigo-950 text-indigo-400 border-indigo-500/30');
        speechHud.textContent = 'Downloading local model (first run)…';
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
    btnStart.disabled = !ready || isPrompting || allWords.length === 0;
    if (!modelReady && wsConnected) btnStart.disabled = true;
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

  // ---- Browser-audio streaming (--browser-audio fallback) ------------------
  function startBrowserAudioStream() {
    if (captureNode || !audioContext || !audioStream) return;
    const source = audioContext.createMediaStreamSource(audioStream);
    captureNode = audioContext.createScriptProcessor(4096, 1, 1);
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    source.connect(captureNode);
    captureNode.connect(silent);
    silent.connect(audioContext.destination);

    captureNode.onaudioprocess = (e) => {
      if (!isPrompting || !ws || ws.readyState !== WebSocket.OPEN) return;
      const raw = e.inputBuffer.getChannelData(0);
      const ratio = audioContext.sampleRate / 16000;
      const outLen = Math.floor(raw.length / ratio);
      if (outLen < 1) return;
      const out = new Float32Array(outLen);
      // Simple decimation-with-averaging downsample to 16 kHz.
      let sum = 0, count = 0, oi = 0;
      for (let i = 0; i < raw.length; i++) {
        sum += raw[i]; count++;
        if (count >= ratio) {
          out[oi++] = sum / count;
          sum = 0; count = 0;
        }
      }
      if (oi > 0) send({ type: 'audio', data: Array.from(out.subarray(0, oi)) });
    };
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
    const midLine = Math.floor(numLines / 2);
    const lineH = 45;
    viewingWindow.style.height = (numLines * lineH) + 'px';
    cursorBar.style.top = (midLine * lineH) + 'px';
    cursorBar.style.height = lineH + 'px';
    scrollingContent.style.paddingTop = (midLine * lineH) + 'px';
  }

  // ---- File upload ----------------------------------------------------------
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith('.txt') || name.endsWith('.md')) {
        transcriptInput.value = await file.text();
      } else if (name.endsWith('.docx')) {
        const buffer = await file.arrayBuffer();
        const res = await mammoth.extractRawText({ arrayBuffer: buffer });
        transcriptInput.value = res.value;
      } else if (name.endsWith('.pdf')) {
        const buffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        let text = '';
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map((it) => it.str).join(' ') + '\n';
        }
        transcriptInput.value = text;
      } else {
        return;
      }
      parseAndRenderTranscript();
    } catch (err) {
      alert('Could not read file: ' + err.message);
    }
  });

  transcriptInput.addEventListener('input', () => {
    parseAndRenderTranscript();
    updateStartButton();
  });

  // ---- Transcript parsing ----------------------------------------------------
  function parseAndRenderTranscript() {
    const rawText = transcriptInput.value.trim();
    if (!rawText) {
      linesContainer.innerHTML = `<p class="h-[45px] flex items-center justify-center text-gray-400 italic">Paste script & press Start Session...</p>`;
      linesData = [];
      allWords = [];
      currentWordIndex = 0;
      currentLineIndex = 0;
      return;
    }

    const rawWords = rawText.split(/\s+/);
    const WORDS_PER_LINE = 8;
    linesData = [];
    allWords = [];
    let globalWordIdx = 0;

    for (let i = 0; i < rawWords.length; i += WORDS_PER_LINE) {
      const lineChunk = rawWords.slice(i, i + WORDS_PER_LINE);
      const lineObj = { lineIdx: linesData.length, words: [] };
      lineChunk.forEach((wordStr) => {
        const wObj = { globalIdx: globalWordIdx, lineIdx: lineObj.lineIdx, original: wordStr };
        lineObj.words.push(wObj);
        allWords.push(wObj);
        globalWordIdx++;
      });
      linesData.push(lineObj);
    }

    linesContainer.innerHTML = linesData.map((line) => {
      const wordsHTML = line.words
        .map((w) => `<span id="w-${w.globalIdx}" class="inline-block mx-1 px-1.5 py-0.5 rounded transition-all duration-150">${w.original}</span>`)
        .join('');
      return `<div id="line-${line.lineIdx}" class="h-[45px] flex items-center justify-center px-4 whitespace-nowrap text-white/60">${wordsHTML}</div>`;
    }).join('');

    currentWordIndex = 0;
    currentLineIndex = 0;
    updateHighlighting(0);
  }

  // ---- Highlighting & scrolling --------------------------------------------
  function updateHighlighting(wordIndex) {
    if (!allWords.length) return;

    const oldWord = linesContainer.querySelector('.bg-yellow-400');
    if (oldWord) oldWord.classList.remove('bg-yellow-400', 'text-black', 'font-bold');

    const oldLine = linesContainer.querySelector('.text-white.font-bold');
    if (oldLine) {
      oldLine.classList.remove('text-white', 'font-bold');
      oldLine.classList.add('text-white/60');
    }

    const activeWordObj = allWords[wordIndex];
    if (!activeWordObj) return;

    currentLineIndex = activeWordObj.lineIdx;

    const wordSpan = document.getElementById(`w-${wordIndex}`);
    if (wordSpan) wordSpan.classList.add('bg-yellow-400', 'text-black', 'font-bold');

    const lineDiv = document.getElementById(`line-${currentLineIndex}`);
    if (lineDiv) {
      lineDiv.classList.remove('text-white/60');
      lineDiv.classList.add('text-white', 'font-bold');
    }

    const translateY = -(currentLineIndex * 45);
    scrollingContent.style.transform = `translateY(${translateY}px)`;
  }

  // ---- Start / Stop ----------------------------------------------------------
  btnStart.addEventListener('click', () => {
    if (isPrompting) return;
    if (!transcriptInput.value.trim()) return;

    parseAndRenderTranscript();
    currentWordIndex = 0;
    isPrompting = true;
    recordedChunks = [];

    activeRecordMode = optRecordMode ? optRecordMode.value : 'video';
    if (optRecordMode) optRecordMode.disabled = true;

    if (audioContext && audioContext.state === 'suspended') audioContext.resume();

    if (browserAudio && audioContext.state === 'running') startBrowserAudioStream();

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
            activeRecordingOptions = getAudioRecorderOptions();
          } else {
            activeRecordingOptions = getVideoRecorderOptions();
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
    btnStop.classList.remove('hidden');
    updateHighlighting(0);
    updateStartButton();
    setBadge(vadStatus, 'LISTENING (LOCAL WHISPER)', 'bg-indigo-950 text-indigo-400 border-indigo-500/30');
    speechHud.textContent = 'Speak into the mic to scroll in sync…';
  });

  btnStop.addEventListener('click', () => {
    isPrompting = false;
    if (optRecordMode) optRecordMode.disabled = false;

    send({ type: 'stop' });

    if (activeRecordMode !== 'off' && mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.onstop = () => {
        const mimeType = activeRecordingOptions.mimeType || (activeRecordMode === 'audio' ? 'audio/webm' : 'video/webm');
        const blob = new Blob(recordedChunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        const prefix = activeRecordMode === 'audio' ? 'Teleprompter-Audio' : 'Teleprompter-Session';
        a.download = `${prefix}-${new Date().toISOString().slice(0, 10)}.${activeRecordingOptions.extension}`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          window.URL.revokeObjectURL(url);
        }, 100);
      };
      mediaRecorder.stop();
      setBadge(vadStatus, 'SAVED', 'bg-green-950 text-green-400 border-green-500/30');
      speechHud.textContent = activeRecordMode === 'audio'
        ? 'Session audio saved to your Mac!'
        : 'Session recording saved to your Mac!';
    } else {
      setBadge(vadStatus, 'STOPPED', 'bg-gray-800 text-gray-400 border-gray-700');
      speechHud.textContent = 'Session ended.';
    }

    btnStart.classList.remove('hidden');
    btnStop.classList.add('hidden');
    recIndicator.classList.add('hidden');
    updateStartButton();
  });

  // ---- Keyboard manual stepping (local override) ----------------------------
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === transcriptInput) return;
    if (e.code === 'ArrowDown' && allWords.length) {
      currentWordIndex = Math.min(allWords.length - 1, currentWordIndex + 1);
      updateHighlighting(currentWordIndex);
    } else if (e.code === 'ArrowUp' && allWords.length) {
      currentWordIndex = Math.max(0, currentWordIndex - 1);
      updateHighlighting(currentWordIndex);
    }
  });

  document.getElementById('btn-toggle-panel').addEventListener('click', () => {
    document.getElementById('side-panel').classList.toggle('hidden');
  });

  // ---- Boot ------------------------------------------------------------------
  parseAndRenderTranscript();
  initCameraAndAudio();
  updateViewportLines(parseInt(optLines.value, 10));
  connect();
})();