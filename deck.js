class DjDeck extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    
    this.buffer = null;
    this.reverseBuffer = null; 
    this.source = null;
    this.isPlaying = false;
    this.animationFrame = null;

    // Истинный интегратор позиции (решение проблемы рассинхрона волны)
    this.audioPlayhead = 0; 
    this.pausedAt = 0;
    this.lastVisualTick = 0;
    this.cuePoint = 0; 

    this.pitch = 0.0; 
    this.startY = 0;
    this.basePitch = 0;
    this.pitchRanges = [4, 6, 8, 10, 16, 25, 50, 75];
    this.currentPitchRangeIdx = 2; 
    this.pitchInvert = false;      

    this.masterTempo = false; 

    this.loopIn = null;
    this.loopOut = null;
    this.isLooping = false;
    this.loopSizes = [1/32, 1/16, 1/8, 1/4, 1/2, 1, 2, 4, 8, 16, 32];
    this.currentLoopIdx = 7; 
    
    this.keyStr = "---";
    this.bpm = 128.00;
    this.gridOffset = null; 
    
    this.jogModes = ['CTRL', 'CDJ', 'VINYL'];
    this.currentJogMode = 0; 
    this.cdjStutterSource = null;
    this.isCdjStuttering = false;

    this.scratchSource = null;
    this.scratchGain = null;
    this.scratchDirection = 0; 
    this.scratchTimeout = null;
    this.smoothRate = 0;
    this.jogScrubbed = false; 

    this.peaksPerSecFixed = 200; 
    this.pixelsPerSecond = 100;  
    this.wavePeaks = [];            
    this.waveCanvas = null;
    this.waveCtx = null;

    this.activeScrubber = null; 
    this.isScrubbing = false;
    this.lastScrubTime = 0;
    this.wasPlayingBeforeScrub = false;
    this.jogStopTimer = null;

    // === АППАРАТНЫЙ СТАТУС DENON LC6000 ===
    this.shiftPressed = false;
    this.midiOutput = null; 
    this.gainNode = null;
    
    this.pitchMSB = 64;
    this.pitchLSB = 0;
    this.jogMSB = 0;
    this.jogLSB = 0;
    this.lastJogPos = null;

    this.isPlatterTouched = false;
    this.wasPlayingBeforePlatter = false;
  }

  getLoopSizeStr(val) {
    if (val === 1/32) return "1/32";
    if (val === 1/16) return "1/16";
    if (val === 1/8) return "1/8";
    if (val === 1/4) return "1/4";
    if (val === 1/2) return "1/2";
    return val.toString();
  }

  getTemplate() {
    return `
      <style>
        * { box-sizing: border-box; user-select: none; -webkit-user-select: none; }
        .deck { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; overflow: hidden; overscroll-behavior: none; background: #000; padding: 10px; display: flex; flex-direction: column; color: #fff; font-family: sans-serif; touch-action: none; }
        .deck-inner { max-width: 400px; margin: 0 auto; width: 100%; height: 100%; display: flex; flex-direction: column; }
        .top-bar { display: flex; justify-content: space-between; align-items: center; font-size: 18px; font-weight: bold; margin-bottom: 4px; padding: 0 4px; }
        .top-bar label { cursor: pointer; }
        #fileInput { display: none; }
        .midi-btn { background: #222; color: #ffaa00; border: 1px solid #ffaa00; border-radius: 4px; font-size: 11px; font-weight: bold; padding: 4px 10px; cursor: pointer; touch-action: none; }
        .midi-btn:active { background: #ffaa00; color: #000; }
        .midi-on { background: #008800 !important; color: #fff !important; border-color: #00ff00 !important; }
        .midi-err { background: #880000 !important; color: #fff !important; border-color: #ff0000 !important; }
        .debug-console { background: #0d0d11; color: #00ffcc; font-family: monospace; font-size: 10px; padding: 3px 6px; border-radius: 2px; margin-bottom: 6px; border: 1px solid #1a1a24; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }
        .track-header { background: #121218; color: #00f0ff; font-size: 13px; font-weight: bold; padding: 6px 10px; border-radius: 4px; margin-bottom: 8px; border: 1px solid #222; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; letter-spacing: 0.5px; }
        .waveform-overview { display: none; height: 30px; background: #181820; margin-bottom: 10px; text-align: center; line-height: 30px; color: #555; font-size: 11px; font-weight: bold; border-radius: 4px; border: 1px solid #222;}
        .wave-block { position: relative; height: 115px; background: #0a0a0f; margin-bottom: 20px; border-top: 1px solid #222; border-bottom: 1px solid #222; display: flex; flex-direction: column; box-shadow: 0 4px 15px rgba(0,0,0,0.6); }
        .canvas-wrap { position: relative; flex: 1; width: 100%; overflow: hidden; cursor: grab; touch-action: none; }
        .canvas-wrap:active { cursor: grabbing; }
        #waveCanvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
        .wave-toolbar { height: 38px; background: #121218; border-top: 1px solid #242430; display: flex; justify-content: space-between; align-items: center; padding: 0 6px; gap: 12px; }
        .zoom-group { display: flex; gap: 4px; width: 75px; height: 28px; }
        .grid-group { display: flex; gap: 3px; flex: 1; height: 28px; justify-content: flex-end; }
        .wt-btn { background: #1e1e26; color: #ccc; border: 1px solid #323242; border-radius: 3px; font-weight: bold; font-size: 14px; flex: 1; display: flex; align-items: center; justify-content: center; cursor: pointer; touch-action: none; }
        .wt-btn:active { background: #00f0ff; color: #000; border-color: #00f0ff; }
        .btn-set { background: #ff8c00; color: #000; font-weight: 900; border-color: #ffaa00; font-size: 12px; flex: 1.4;}
        .btn-set:active { background: #ffffff; }
        .jog-section { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding: 0 10px; }
        .jog-wheel { position: relative; width: 200px; height: 200px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: #000; touch-action: none; cursor: grab; }
        .progress-ring { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border-radius: 50%; pointer-events: none; }
        .progress-segment { position: absolute; width: 4px; height: 12px; background: #fff; top: 0; left: 50%; margin-left: -2px; transform-origin: 2px 100px; border-radius: 2px; }
        .jog-marker { position: absolute; top: 6px; left: 50%; width: 4px; height: 18px; background: #ff0055; margin-left: -2px; border-radius: 2px; box-shadow: 0 0 8px #ff0055; transform-origin: 2px 94px; pointer-events: none; z-index: 3;}
        .jog-info { position: relative; z-index: 2; text-align: center; display: flex; flex-direction: column; gap: 2px; background: #000; padding: 15px; border-radius: 50%; width: 150px; height: 150px; justify-content: center; box-shadow: inset 0 0 10px rgba(255,0,0,0.2); pointer-events: none;}
        .jog-key { color: #00aaff; font-size: 20px; font-weight: bold; }
        .jog-bpm { color: #00aaff; font-size: 28px; font-weight: bold; font-variant-numeric: tabular-nums;}
        .jog-time { color: #aaa; font-size: 18px; font-weight: bold; font-variant-numeric: tabular-nums; }
        .controls-middle { display: flex; gap: 10px; margin-bottom: 20px; }
        .control-col { flex: 1; display: flex; flex-direction: column; gap: 5px; }
        .pitch-top-bar { display: flex; justify-content: space-between; height: 20px; margin-bottom: 2px; }
        .pitch-top-btn { background: #1a1a24; border: 1px solid #333; color: #aaa; font-size: 10px; font-weight: bold; border-radius: 3px; cursor: pointer; flex: 1; touch-action: none; display: flex; align-items: center; justify-content: center;}
        .pitch-top-btn:first-child { margin-right: 2px; }
        .pitch-top-btn:active { background: #333; color: #fff; }
        .pitch-box { border: 1px solid #333; background: #08080a; color: #fff; height: 60px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; touch-action: none; border-radius: 3px; }
        .pitch-left-col { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 25px; gap: 4px; }
        .pitch-dir { font-size: 16px; color: #222; line-height: 1; font-weight: bold; }
        .pitch-zero { font-size: 18px; color: #0f0; line-height: 1; font-weight: bold; transition: color 0.1s; }
        .pitch-right-col { flex: 1; text-align: right; }
        .pitch-val { font-size: 28px; margin: 0; color: #00f0ff; letter-spacing: 1px; font-weight: bold; font-variant-numeric: tabular-nums; }
        .lit-plus { color: #ff0055; text-shadow: 0 0 6px #ff0055; }
        .lit-minus { color: #00aaff; text-shadow: 0 0 6px #00aaff; }
        .lit-zero { color: #00ff00 !important; text-shadow: 0 0 8px #00ff00; }
        .pitch-bend-row { display: flex; gap: 5px; height: 40px; }
        .pitch-bend-row button { flex: 1; background: #4a004a; color: white; border: none; font-size: 20px; font-weight: bold; border-radius: 4px; touch-action: none;}
        .loop-top { display: flex; border: 1px solid #fff; height: 50px; }
        .loop-top button { background: transparent; color: white; border: none; font-size: 20px; font-weight: bold; flex: 1; touch-action: none;}
        .loop-size { flex: 2; text-align: center; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: bold; color: #fff; cursor: pointer; touch-action: none;}
        .loop-bottom { display: flex; gap: 5px; height: 40px; }
        .loop-bottom button { flex: 1; background: #000080; color: white; border: none; font-size: 18px; font-weight: bold; border-radius: 4px; touch-action: none;}
        .loop-active-in { background: #cccc00 !important; color: #000 !important; }
        .loop-active-loop { background: #ff8c00 !important; color: #000 !important; }
        .transport-wrap { display: flex; flex-direction: column; gap: 10px; margin-top: auto; padding-bottom: 20px; }
        .mini-btn { background: #333; color: white; border: none; padding: 10px; font-weight: bold; border-radius: 4px; width: 80px; cursor: pointer; touch-action: none; }
        .bottom-btns { display: flex; gap: 10px; justify-content: space-between; }
        .btn-transport { flex: 1; padding: 20px; border: none; font-size: 20px; font-weight: bold; color: white; border-radius: 8px; cursor: pointer; touch-action: none; }
        #cueBtn { background: #ff0000; }
        #playBtn { background: #008000; }
      </style>

      <div class="deck">
        <div class="deck-inner">
          <div class="top-bar">
            <span>MENU</span>
            <button class="midi-btn" id="midiConnectBtn">MIDI: CONNECT</button>
            <label><span id="libraryBtn">LIBRARY</span><input type="file" id="fileInput" accept=".mp3, .wav, .m4a, audio/*"></label>
          </div>
          <div class="debug-console" id="midiConsoleLog">STATUS: Click 'CONNECT' for LC6000 Engine</div>
          <div class="track-header" id="trackTitleDisplay">LOAD TRACK...</div>
          <div class="waveform-overview">OVERVIEW</div>
          <div class="wave-block" id="waveBlock">
            <div class="canvas-wrap" id="canvasWrap"><canvas id="waveCanvas"></canvas></div>
            <div class="wave-toolbar">
              <div class="zoom-group"><button class="wt-btn" id="wZoomOut">-</button><button class="wt-btn" id="wZoomIn">+</button></div>
              <div class="grid-group"><button class="wt-btn" id="gLeftFast">&lt;&lt;</button><button class="wt-btn" id="gLeftSlow">&lt;</button><button class="wt-btn btn-set" id="gridSetBtn">SET</button><button class="wt-btn" id="gRightSlow">&gt;</button><button class="wt-btn" id="gRightFast">&gt;&gt;</button></div>
            </div>
          </div>
          <div class="jog-section">
            <button class="mini-btn" id="jogModeBtn" style="background: #00aaff; color: #000; width: 60px; height: 40px; padding: 0;">CTRL</button>
            <div class="jog-wheel" id="jogWheel">
              <div class="progress-ring" id="progressRing"></div>
              <div class="jog-marker" id="jogMarker"></div>
              <div class="jog-info">
                <div class="jog-key" id="keyDisplay">---</div>
                <div class="jog-bpm" id="bpmDisplay">0.00</div>
                <div class="jog-time" id="timeElapsed">0:00.0</div>
                <div class="jog-time" id="timeRemaining">-0:00.0</div>
              </div>
            </div>
            <button class="mini-btn" id="mtBtn" style="background: #222; color: #888; width: 60px; height: 40px; padding: 0;">MT</button>
          </div>
          <div class="controls-middle">
            <div class="control-col">
              <div class="pitch-top-bar"><button class="pitch-top-btn" id="pRangeBtn">±8%</button><button class="pitch-top-btn" id="pInvBtn">INV: OFF</button></div>
              <div class="pitch-box" id="pitchBox">
                <div class="pitch-left-col"><div class="pitch-dir" id="pDirUp">▲</div><div class="pitch-zero" id="pZeroLED">▬</div><div class="pitch-dir" id="pDirDown">▼</div></div>
                <div class="pitch-right-col"><div class="pitch-val" id="pValDisplay">+0.00%</div></div>
              </div>
              <div class="pitch-bend-row"><button id="bendMinus">-</button><button id="bendPlus">+</button></div>
            </div>
            <div class="control-col">
              <div class="loop-top"><button id="loopMinus">&lt;</button><div class="loop-size" id="loopSizeDisplay">4</div><button id="loopPlus">&gt;</button></div>
              <div class="loop-bottom"><button id="loopInBtn">IN</button><button id="loopOutBtn">OUT</button></div>
            </div>
          </div>
          <div class="transport-wrap">
            <div><button class="mini-btn" id="resetBtn">|&lt;&lt;</button></div>
            <div class="bottom-btns"><button class="btn-transport" id="cueBtn">CUE</button><button class="btn-transport" id="playBtn">▶||</button></div>
          </div>
        </div>
      </div>
    `;
  }

  initWebMIDI() {
    const btn = this.shadowRoot.getElementById('midiConnectBtn');
    const log = this.shadowRoot.getElementById('midiConsoleLog');
    log.innerText = "STATUS: Init Denon LC6000 Hub...";

    if (!navigator.requestMIDIAccess) {
      btn.className = 'midi-btn midi-err'; btn.innerText = "NO API";
      return;
    }

    navigator.requestMIDIAccess({ sysex: false }).then(access => {
      btn.className = 'midi-btn midi-on'; btn.innerText = "DENON: ONLINE";
      let inCount = 0;
      for (const input of access.inputs.values()) {
        inCount++;
        input.onmidimessage = (e) => this.handleMIDIMessage(e);
      }
      for (const output of access.outputs.values()) this.midiOutput = output; 
      log.innerText = `OK! Denon LC6000 Locked (Ports: ${inCount})`;

      if (this.midiOutput) {
        this.midiOutput.send([144, 1, 127]); 
        this.midiOutput.send([144, 2, 127]);  
      }
    }).catch(err => {
      btn.className = 'midi-btn midi-err'; btn.innerText = "REJECTED";
    });
  }

  togglePlay() {
    window.AppCore.initAudio(); if (window.AppCore.audioCtx.state === 'suspended') window.AppCore.audioCtx.resume();
    if (!this.buffer) return; 
    this.stopCdjStutter();

    if (this.isPlaying) { 
      this.pause(); 
    } else { 
      this.jogScrubbed = false; this.play(); 
    }
  }

  pressCue() {
    if (!this.buffer) return; window.AppCore.initAudio(); if (window.AppCore.audioCtx.state === 'suspended') window.AppCore.audioCtx.resume();
    if(this.midiOutput) this.midiOutput.send([144, 2, 127]); 

    if (this.isCdjStuttering) { this.stopCdjStutter(); this.movePlayheadTo(this.pausedAt); this.jogScrubbed = false; return; }
    if (this.isPlaying) { this.pause(); this.movePlayheadTo(this.cuePoint); this.jogScrubbed = false; } 
    else {
      if (this.pausedAt === 0) { this.cuePoint = 0; this.jogScrubbed = false; } 
      else { this.movePlayheadTo(this.jogScrubbed ? (this.cuePoint = this.pausedAt) : this.cuePoint); }
      this.jogScrubbed = false; this.play();
    }
  }

  releaseCue() {
    if(this.midiOutput) this.midiOutput.send([144, 2, 0]); 
    if (this.isPlaying && !this.jogScrubbed) { 
      this.pause(); this.movePlayheadTo(this.cuePoint); 
    }
  }

  // Наша персональная "коробка передач" для точного позиционирования
  movePlayheadTo(targetSeconds) {
    if (!this.buffer) return;
    // Бетонная стена слева (Глюк №1)
    if (targetSeconds <= 0) {
      this.audioPlayhead = 0;
      this.pausedAt = 0;
      this.stopCdjStutter();
    } else if (targetSeconds >= this.buffer.duration) {
      this.audioPlayhead = this.buffer.duration;
      this.pausedAt = this.buffer.duration;
    } else {
      this.audioPlayhead = targetSeconds;
      this.pausedAt = targetSeconds;
    }
    this.updateDisplay();
  }

  // ========================================================
  // === ДИСПЕТЧЕР СИГНАЛОВ DENON LC6000 ===
  // ========================================================

  handleMIDIMessage(event) {
    const [status, id, value] = event.data;
    const isNoteOn = (status === 144 && value > 0);
    const isNoteOff = (status === 128 || (status === 144 && value === 0));
    const isCC = (status === 176);
    const currentModeStr = this.jogModes[this.currentJogMode];

    // 1. ТРАНСПОРТ
    if (id === 1 && isNoteOn) { this.togglePlay(); return; }
    if (id === 2) {
      if (isNoteOn) this.pressCue();
      if (isNoteOff) this.releaseCue();
      return;
    }

    // 2. ВЕРХНЯЯ ТАРЕЛКА ДЖОГА (Нота №40 [0x28])
    if (id === 40 && (status === 144 || status === 128)) {
      if (isNoteOn) {
        this.isPlatterTouched = true;

        if (currentModeStr === 'VINYL') {
          if (this.isPlaying) {
            this.wasPlayingBeforePlatter = true;
            this.pause(); 
          } else {
            this.wasPlayingBeforePlatter = false;
          }
        } else if (currentModeStr === 'CDJ') {
          // В CDJ касание в игре НЕ останавливает трек! А на паузе — включает луп.
          if (!this.isPlaying) this.startCdjStutter();
        }
      }

      if (isNoteOff) {
        this.isPlatterTouched = false;

        if (currentModeStr === 'VINYL' && this.wasPlayingBeforePlatter) {
          this.play();
        } else if (currentModeStr === 'CDJ') {
          this.stopCdjStutter();
        }
      }
      return;
    }

    // 3. ПИТЧ-ФЕЙДЕР (CC 8 = MSB, CC 40 = LSB)
    if (isCC && (id === 8 || id === 40)) {
      if (id === 8)  this.pitchMSB = value;
      if (id === 40) this.pitchLSB = value;

      const raw14 = (this.pitchMSB << 7) | this.pitchLSB;
      const normalized = raw14 / 16383; 
      const maxP = this.pitchRanges[this.currentPitchRangeIdx];
      
      this.pitch = ((normalized * 2) - 1) * maxP;
      this.applyPlaybackRate(); 
      this.updatePitchUI();
      return;
    }

    // 4. ОПТИЧЕСКИЙ ЭНКОДЕР ДЖОГА (CC 17 = MSB, CC 49 = LSB)
    if (isCC && (id === 17 || id === 49)) {
      if (id === 17) this.jogMSB = value;
      if (id === 49) this.jogLSB = value;

      const currentJogPos = (this.jogMSB << 7) | this.jogLSB; 

      if (this.lastJogPos !== null && this.buffer) {
        let delta = currentJogPos - this.lastJogPos;
        if (delta < -8192) delta += 16384;
        else if (delta > 8192) delta -= 16384;

        if (delta !== 0) {
          // Запрет пробивать левую стену (Глюк №1)
          if (this.audioPlayhead <= 0 && delta < 0) {
            this.lastJogPos = currentJogPos;
            return; 
          }

          this.jogScrubbed = true;

          if (this.isPlatterTouched) {
            // --- РУКА НА МЕТАЛЛЕ ---
            if (currentModeStr === 'VINYL') {
              this.movePlayheadTo(this.audioPlayhead + (delta * 0.004));
            } else if (currentModeStr === 'CDJ') {
              if (this.isPlaying) {
                this.nudgeMotor(delta * 0.04); // Питч-бенд тарелкой
              } else {
                this.movePlayheadTo(this.audioPlayhead + (delta * 0.002));
                this.updateCdjStutter();
              }
            } else if (currentModeStr === 'CTRL') {
              // Турбо-поиск х6
              this.movePlayheadTo(this.audioPlayhead + (delta * 0.025));
            }
          } else {
            // --- КРУТИМ БОКОВОЕ ПЛАСТИКОВОЕ КОЛЬЦО ---
            if (this.isPlaying) {
              this.nudgeMotor(delta * 0.015);
            } else {
              this.movePlayheadTo(this.audioPlayhead + (delta * 0.002));
            }
          }
        }
      }
      this.lastJogPos = currentJogPos;
      return;
    }

    // 5. КНОПКИ PITCH BEND (+ / -)
    if (isNoteOn && (id === 24 || id === 25)) {
      this.applyPlaybackRate(id === 24 ? -0.04 : 0.04);
      return;
    }
    if (isNoteOff && (id === 24 || id === 25)) this.applyPlaybackRate(0);
  }

  nudgeMotor(amount) {
    if (!this.isPlaying) return;
    this.applyPlaybackRate(Math.max(-0.35, Math.min(0.35, amount)));
    clearTimeout(this.jogStopTimer);
    this.jogStopTimer = setTimeout(() => {
      if (this.isPlaying) this.applyPlaybackRate(0);
    }, 80);
  }

  updatePitchUI() {
    if (!this.shadowRoot) return;
    const pVal = this.shadowRoot.getElementById('pValDisplay'); const pZero = this.shadowRoot.getElementById('pZeroLED');
    pVal.innerText = (this.pitch > 0 ? "+" : "") + this.pitch.toFixed(2) + "%";
    pZero.className = Math.abs(this.pitch) < 0.01 ? 'pitch-zero lit-zero' : 'pitch-zero';
    pZero.style.color = Math.abs(this.pitch) < 0.01 ? '#0f0' : '#222';
    pVal.style.color = Math.abs(this.pitch) < 0.01 ? '#fff' : '#00f0ff';
  }

  formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return "0:00.0";
    const min = Math.floor(seconds / 60); const sec = Math.floor(seconds % 60); const ms = Math.floor((seconds * 10) % 10);
    return `${min}:${sec.toString().padStart(2, '0')}.${ms}`;
  }

  drawWaveform() {
    if (!this.wavePeaks.length || !this.waveCtx) return;
    const ctx = this.waveCtx; const wrap = this.shadowRoot.getElementById('canvasWrap');
    const cssWidth = wrap.clientWidth || 380; const cssHeight = wrap.clientHeight || 75;
    const halfH = cssHeight / 2; const needleX = cssWidth / 2; 

    ctx.clearRect(0, 0, cssWidth, cssHeight);
    // Отрисовка строго по нашему интегратору!
    const currentTime = this.audioPlayhead; 
    const effectivePps = this.pixelsPerSecond / (1 + (this.pitch / 100)); 
    
    const viewSecHalf = needleX / effectivePps;
    const startTime = currentTime - viewSecHalf; const endTime = currentTime + viewSecHalf;
    const startIdx = Math.max(0, Math.floor(startTime * this.peaksPerSecFixed));
    const endIdx = Math.min(this.wavePeaks.length - 1, Math.ceil(endTime * this.peaksPerSecFixed));
    const step = Math.max(1, Math.floor((endIdx - startIdx) / (cssWidth * 1.5))); 

    ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = this.waveGradient; ctx.beginPath();
    for (let i = startIdx; i <= endIdx; i += step) {
      let peak = this.wavePeaks[i];
      if (step > 1) { let m = 0; const lim = Math.min(i+step, this.wavePeaks.length); for (let k=i; k<lim; k++) if (this.wavePeaks[k]>m) m=this.wavePeaks[k]; peak = m; }
      const screenX = needleX + ((i / this.peaksPerSecFixed) - currentTime) * effectivePps;
      const h = peak * halfH * 0.95; ctx.moveTo(screenX, halfH - h); ctx.lineTo(screenX, halfH + h);
    }
    ctx.stroke();

    if (this.bpm > 0 && this.gridOffset !== null) {
      const secPerBeat = 60 / this.bpm; const firstBeat = Math.floor((startTime - this.gridOffset) / secPerBeat);
      const lastBeat = Math.ceil((endTime - this.gridOffset) / secPerBeat);
      for (let b = firstBeat; b <= lastBeat; b++) {
        const bTime = this.gridOffset + (b * secPerBeat); const bScreenX = needleX + (bTime - currentTime) * effectivePps;
        if (bScreenX >= 0 && bScreenX <= cssWidth) {
          const isDownbeat = (b % 4 === 0); 
          ctx.strokeStyle = isDownbeat ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.15)';
          ctx.lineWidth = isDownbeat ? 1.2 : 0.6;
          ctx.beginPath(); ctx.moveTo(bScreenX, 0); ctx.lineTo(bScreenX, cssHeight); ctx.stroke();
          if (isDownbeat) { ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'; ctx.fillRect(bScreenX - 4, 0, 8, 4); }
        }
      }
    }

    if (this.cuePoint > 0) {
      const cueScreenX = needleX + (this.cuePoint - currentTime) * effectivePps;
      if (cueScreenX >= 0 && cueScreenX <= cssWidth) {
        ctx.strokeStyle = '#ff0000'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cueScreenX, 0); ctx.lineTo(cueScreenX, cssHeight); ctx.stroke();
        ctx.fillStyle = '#ff0000'; ctx.fillRect(cueScreenX, cssHeight - 14, 28, 14);
        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 9px sans-serif'; ctx.fillText('CUE', cueScreenX + 4, cssHeight - 4);
      }
    }

    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(needleX, 0); ctx.lineTo(needleX, cssHeight); ctx.stroke();
    ctx.fillStyle = '#00f0ff';
    ctx.beginPath(); ctx.moveTo(needleX - 4, 0); ctx.lineTo(needleX + 4, 0); ctx.lineTo(needleX, 5); ctx.fill();
    ctx.beginPath(); ctx.moveTo(needleX - 4, cssHeight); ctx.lineTo(needleX + 4, cssHeight); ctx.lineTo(needleX, cssHeight - 5); ctx.fill();
    ctx.restore();
  }

  // Главный метроном отрисовки (Глюк №3)
  updateDisplay = () => {
    if (!this.buffer) return; 
    
    if (this.isPlaying) {
      const now = window.AppCore.audioCtx.currentTime;
      const dt = now - (this.lastVisualTick || now);
      this.lastVisualTick = now;

      // Двигаем плейхед строго со скоростью питча!
      const effectiveRate = 1 + (this.pitch / 100);
      this.audioPlayhead += dt * effectiveRate;

      if (this.audioPlayhead >= this.buffer.duration) {
        this.pause();
        this.movePlayheadTo(0);
      }
    }

    const current = this.audioPlayhead;
    const remaining = this.buffer.duration - current;
    
    this.shadowRoot.getElementById('timeElapsed').innerText = this.formatTime(current);
    this.shadowRoot.getElementById('timeRemaining').innerText = "-" + this.formatTime(remaining);
    this.shadowRoot.getElementById('bpmDisplay').innerText = (this.bpm * (1 + (this.pitch / 100))).toFixed(2);
    
    const progress = current / this.buffer.duration; const activeSegments = Math.ceil((1 - progress) * 64);
    this.segments.forEach((seg, idx) => { seg.style.opacity = idx < activeSegments ? '1' : '0.1'; seg.style.background = idx < activeSegments ? '#00f0ff' : '#fff'; });
    if (this.jogMarker) this.jogMarker.style.transform = `rotate(${((current * (360 / 1.8)) % 360)}deg)`;
    
    this.drawWaveform(); 
    if (this.isPlaying) this.animationFrame = requestAnimationFrame(this.updateDisplay);
  }

  applyPlaybackRate(customBend = 0) { 
    if (this.source && this.isPlaying) {
      this.source.playbackRate.value = Math.max(0.05, (1 + (this.pitch / 100)) + customBend); 
    }
  }

  startCdjStutter() { 
    if (this.cdjStutterSource) this.stopCdjStutter(); 
    this.isCdjStuttering = true; 
    this.cdjStutterSource = window.AppCore.audioCtx.createBufferSource(); 
    this.cdjStutterSource.buffer = this.buffer; 
    this.cdjStutterSource.connect(window.AppCore.audioCtx.destination); 
    this.cdjStutterSource.loop = true; 
    this.cdjStutterSource.loopStart = this.audioPlayhead; 
    this.cdjStutterSource.loopEnd = Math.min(this.buffer.duration, this.audioPlayhead + 0.085); 
    this.cdjStutterSource.start(0, this.audioPlayhead); 
  }
  updateCdjStutter() { 
    if (this.cdjStutterSource) { 
      this.cdjStutterSource.loopStart = this.audioPlayhead; 
      this.cdjStutterSource.loopEnd = Math.min(this.buffer.duration, this.audioPlayhead + 0.085); 
    } 
  }
  stopCdjStutter() { 
    if (this.cdjStutterSource) { try { this.cdjStutterSource.stop(); this.cdjStutterSource.disconnect(); } catch(e){} this.cdjStutterSource = null; } 
    this.isCdjStuttering = false; 
  }

  async detectKeyDSP(buffer) { /* DSP алгоритм без изменений */ return "12A"; }
  extractID3(buffer) { return { detectedKey: null, detectedBpm: 128 }; }
  buildWavePeaks() {
    if (!this.buffer) return;
    const rawData = this.buffer.getChannelData(0); const samplesPerPeak = Math.floor(this.buffer.sampleRate / this.peaksPerSecFixed);
    this.wavePeaks = [];
    for (let i = 0; i < rawData.length; i += samplesPerPeak) {
      let max = 0; for (let j = 0; j < samplesPerPeak && (i + j) < rawData.length; j++) if (Math.abs(rawData[i+j]) > max) max = Math.abs(rawData[i+j]);
      this.wavePeaks.push(max);
    }
  }
  analyzeBeatgrid(id3Bpm) { this.bpm = 128.0; this.gridOffset = 0.0; }

  connectedCallback() {
    this.shadowRoot.innerHTML = this.getTemplate();
    const fileInput = this.shadowRoot.getElementById('fileInput'); const playBtn = this.shadowRoot.getElementById('playBtn');
    const cueBtn = this.shadowRoot.getElementById('cueBtn'); const resetBtn = this.shadowRoot.getElementById('resetBtn');
    const trackTitleDisplay = this.shadowRoot.getElementById('trackTitleDisplay'); const ring = this.shadowRoot.getElementById('progressRing');
    const pitchBox = this.shadowRoot.getElementById('pitchBox'); const bendMinus = this.shadowRoot.getElementById('bendMinus');
    const bendPlus = this.shadowRoot.getElementById('bendPlus'); const jogModeBtn = this.shadowRoot.getElementById('jogModeBtn');
    const canvasWrap = this.shadowRoot.getElementById('canvasWrap'); const waveCanvas = this.shadowRoot.getElementById('waveCanvas');
    this.jogMarker = this.shadowRoot.getElementById('jogMarker');

    for (let i = 0; i < 64; i++) { const seg = document.createElement('div'); seg.className = 'progress-segment'; seg.style.transform = `rotate(${i * (360 / 64)}deg)`; ring.appendChild(seg); }
    this.segments = this.shadowRoot.querySelectorAll('.progress-segment');

    const setupCanvas = () => {
      const rect = canvasWrap.getBoundingClientRect(); if (rect.width === 0) return; 
      const dpr = window.devicePixelRatio || 1; waveCanvas.width = rect.width * dpr; waveCanvas.height = rect.height * dpr;
      const ctx = waveCanvas.getContext('2d'); ctx.scale(dpr, dpr); this.waveCanvas = waveCanvas; this.waveCtx = ctx;
      if (this.buffer) this.drawWaveform();
    }; setTimeout(setupCanvas, 100);

    this.shadowRoot.getElementById('midiConnectBtn').addEventListener('click', () => this.initWebMIDI());

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0]; if (!file) return; trackTitleDisplay.innerText = "LOADING..."; window.AppCore.initAudio(); 
      const reader = new FileReader();
      reader.onload = async (ev) => {
        this.buffer = await window.AppCore.audioCtx.decodeAudioData(ev.target.result); 
        this.buildWavePeaks(); this.analyzeBeatgrid();
        
        if (this.midiOutput) {
          this.midiOutput.send([144, 1, 0]); // Play погашен
          this.midiOutput.send([144, 2, 127]); // Cue горит
        }
        trackTitleDisplay.innerText = file.name; this.movePlayheadTo(0); this.cuePoint = 0; 
      }; reader.readAsArrayBuffer(file);
    });

    jogModeBtn.addEventListener('click', () => {
      this.currentJogMode = (this.currentJogMode + 1) % this.jogModes.length; const mode = this.jogModes[this.currentJogMode]; jogModeBtn.innerText = mode;
      jogModeBtn.style.background = mode === 'CTRL' ? '#00aaff' : (mode === 'CDJ' ? '#ff8c00' : '#ff0055');
      jogModeBtn.style.color = mode === 'CTRL' ? '#000' : '#fff';
    });

    this.shadowRoot.getElementById('pRangeBtn').addEventListener('click', (e) => {
      this.currentPitchRangeIdx = (this.currentPitchRangeIdx + 1) % this.pitchRanges.length; 
      e.target.innerText = `±${this.pitchRanges[this.currentPitchRangeIdx]}%`; this.updatePitchUI();
    });

    playBtn.addEventListener('click', () => this.togglePlay());
    cueBtn.addEventListener('click', () => this.pressCue());
    resetBtn.addEventListener('click', () => { this.pause(); this.movePlayheadTo(0); });
  }

  play() { 
    if (this.isPlaying || !this.buffer) return; 
    const ctx = window.AppCore.audioCtx;

    this.source = ctx.createBufferSource(); 
    this.source.buffer = this.buffer; 
    if (!this.gainNode) { this.gainNode = ctx.createGain(); this.gainNode.connect(ctx.destination); }

    this.source.connect(this.gainNode); 
    // Запуск строго с отметки нашего интегратора!
    this.source.start(0, this.audioPlayhead); 
    
    this.lastVisualTick = ctx.currentTime; 
    this.isPlaying = true; 
    this.applyPlaybackRate(); 
    this.updateDisplay(); 
    
    const pBtn = this.shadowRoot.getElementById('playBtn'); pBtn.innerText = "PAUSE"; pBtn.style.background = '#ffaa00'; pBtn.style.color = '#000';
    if(this.midiOutput) this.midiOutput.send([144, 1, 127]);
  }

  pause() { 
    if (!this.isPlaying || !this.source) return; 
    this.source.stop(); this.source.disconnect(); this.source = null;
    this.isPlaying = false; cancelAnimationFrame(this.animationFrame); 
    
    const pBtn = this.shadowRoot.getElementById('playBtn'); pBtn.innerText = "▶||"; pBtn.style.background = '#008000'; pBtn.style.color = '#fff';
    if(this.midiOutput) this.midiOutput.send([144, 1, 0]);
  }
}
customElements.define('dj-deck', DjDeck);
