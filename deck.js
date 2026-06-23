// === ВСТРОЕННЫЙ НИЗКОУРОВНЕВЫЙ ДВИЖОК ВИНИЛА (AUDIO WORKLET) ===
const resamplerWorkletCode = `
class ResamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pointer = 0;
    this.rate = 1.0;
    this.isPlaying = false;
    this.leftBuffer = null;
    this.rightBuffer = null;
    this.maxLen = 0;
    this.sampleRate = 44100;
    
    this.isLooping = false;
    this.loopIn = 0;
    this.loopOut = 0;
    this.tickCounter = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'load') {
        this.leftBuffer = msg.left;
        this.rightBuffer = msg.right;
        this.maxLen = this.leftBuffer.length;
        this.sampleRate = msg.sampleRate || 44100;
        this.pointer = 0;
      } else if (msg.type === 'play') {
        this.isPlaying = true;
      } else if (msg.type === 'pause') {
        this.isPlaying = false;
      } else if (msg.type === 'set_rate') {
        this.rate = msg.rate;
      } else if (msg.type === 'seek') {
        this.pointer = msg.targetSec * this.sampleRate;
        if (this.pointer < 0) this.pointer = 0;
        if (this.pointer >= this.maxLen) this.pointer = this.maxLen - 1;
      } else if (msg.type === 'scrub') {
        this.pointer += msg.deltaSec * this.sampleRate;
        if (this.pointer < 0) this.pointer = 0;
        if (this.pointer >= this.maxLen) this.pointer = this.maxLen - 1;
      } else if (msg.type === 'set_loop') {
        this.isLooping = msg.isLooping;
        this.loopIn = msg.loopIn * this.sampleRate;
        this.loopOut = msg.loopOut * this.sampleRate;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    if (!this.leftBuffer || !outL) return true;

    const len = outL.length;
    for (let i = 0; i < len; i++) {
      // Проверка на столкновение с бетонной стеной
      if (this.pointer < 0 || this.pointer >= this.maxLen - 1) {
        outL[i] = 0;
        if (outR) outR[i] = 0;
        continue;
      }

      // Линейная интерполяция сэмплов (бархатный звук без щелчков)
      const idx = Math.floor(this.pointer);
      const frac = this.pointer - idx;
      const sL0 = this.leftBuffer[idx];
      const sL1 = this.leftBuffer[idx + 1] || 0;
      outL[i] = sL0 + (sL1 - sL0) * frac;

      if (outR && this.rightBuffer) {
        const sR0 = this.rightBuffer[idx];
        const sR1 = this.rightBuffer[idx + 1] || 0;
        outR[i] = sR0 + (sR1 - sR0) * frac;
      }

      if (this.isPlaying) {
        this.pointer += this.rate;

        // Аппаратная петля с точностью до сэмпла
        if (this.isLooping && this.loopOut > this.loopIn) {
          if (this.pointer >= this.loopOut) {
            this.pointer = this.loopIn + (this.pointer - this.loopOut) % (this.loopOut - this.loopIn);
          }
        }
      }
    }

    // Отправка точных координат иглы в UI ~30 раз в секунду
    this.tickCounter += len;
    if (this.tickCounter >= 1470) {
      this.tickCounter = 0;
      this.port.postMessage({ currentTime: this.pointer / this.sampleRate });
    }

    return true;
  }
}
registerProcessor('resampler-worklet', ResamplerProcessor);
`;

class DjDeck extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    
    this.buffer = null;
    this.reverseBuffer = null; 
    this.source = null;
    this.startTime = 0;
    this.pausedAt = 0;
    this.cuePoint = 0; 
    this.isPlaying = false;
    this.isStuttering = false;
    this.animationFrame = null;

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
    this.bendTimeout = null;

    // === АППАРАТНЫЙ СТАТУС DENON LC6000 ===
    this.shiftPressed = false;
    this.midiOutput = null; 
    this.gainNode = null;
    this.jogStopTimer = null; 

    this.workletNode = null;
    this._isPlatterTouched = false;
    this._wasPlayingBeforePlatter = false;
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
          <div class="debug-console" id="midiConsoleLog">STATUS: Click 'CONNECT' to init Denon LC6000</div>
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

  async setupAudioEngine() {
    const ctx = window.AppCore.audioCtx;
    if (!this.workletNode && ctx) {
      try {
        const blob = new Blob([resamplerWorkletCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(url);

        this.workletNode = new AudioWorkletNode(ctx, 'resampler-worklet', { outputChannelCount: [2] });
        if (!this.gainNode) {
          this.gainNode = ctx.createGain();
          this.gainNode.connect(ctx.destination);
        }
        this.workletNode.connect(this.gainNode);

        // Синхронизация позиции из ворклета в UI
        this.workletNode.port.onmessage = (e) => {
          if (e.data.currentTime !== undefined) {
            this.pausedAt = e.data.currentTime;
          }
        };
      } catch (err) {
        console.error("AudioWorklet Init Failed:", err);
      }
    }
  }

  seekTo(targetSeconds) {
    if (!this.buffer || !this.workletNode) return;
    let sec = targetSeconds;
    if (sec <= 0) sec = 0;
    if (sec >= this.buffer.duration) sec = this.buffer.duration - 0.001;

    this.pausedAt = sec;
    this.workletNode.port.postMessage({ type: 'seek', targetSec: sec });
    this.updateDisplay();
  }

  initWebMIDI() {
    const btn = this.shadowRoot.getElementById('midiConnectBtn');
    const log = this.shadowRoot.getElementById('midiConsoleLog');
    log.innerText = "STATUS: Requesting Denon LC6000 API...";

    if (!navigator.requestMIDIAccess) {
      btn.className = 'midi-btn midi-err'; btn.innerText = "NO API";
      log.innerText = "ERR: Your browser strictly blocks Web MIDI!";
      return;
    }

    navigator.requestMIDIAccess({ sysex: false }).then(access => {
      btn.className = 'midi-btn midi-on'; btn.innerText = "DENON: ONLINE";
      let inCount = 0, outCount = 0;

      for (const input of access.inputs.values()) {
        inCount++; input.onmidimessage = (e) => this.handleMIDIMessage(e);
      }
      for (const output of access.outputs.values()) {
        outCount++; this.midiOutput = output; 
      }
      log.innerText = `OK! Denon LC6000 Active (In:${inCount} Out:${outCount})`;

      if (this.midiOutput) {
        this.midiOutput.send([144, 1, 127]); 
        this.midiOutput.send([144, 2, 127]);  
      }
    }).catch(err => {
      btn.className = 'midi-btn midi-err'; btn.innerText = "REJECTED";
      log.innerText = `DENIED: ${err.message}`;
    });
  }

  togglePlay() {
    window.AppCore.initAudio(); if (window.AppCore.audioCtx.state === 'suspended') window.AppCore.audioCtx.resume();
    if (!this.buffer) return; 
    this.stopCdjStutter();
    const playBtn = this.shadowRoot.getElementById('playBtn');

    if (this.isPlaying) { 
      this.pause(); playBtn.innerText = "▶||"; 
      if(this.midiOutput) this.midiOutput.send([144, 1, 0]); 
    } else { 
      this.jogScrubbed = false; this.play(); playBtn.innerText = "PAUSE"; 
      if(this.midiOutput) this.midiOutput.send([144, 1, 127]); 
    }
  }

  pressCue() {
    if (!this.buffer) return; window.AppCore.initAudio(); if (window.AppCore.audioCtx.state === 'suspended') window.AppCore.audioCtx.resume();
    const playBtn = this.shadowRoot.getElementById('playBtn');
    if(this.midiOutput) this.midiOutput.send([144, 2, 127]); 

    if (this.isCdjStuttering) { this.stopCdjStutter(); this.seekTo(this.pausedAt); this.jogScrubbed = false; this.updateDisplay(); return; }
    if (this.isPlaying) { this.pause(); this.seekTo(this.cuePoint); this.jogScrubbed = false; this.updateDisplay(); playBtn.innerText = "▶||"; if(this.midiOutput) this.midiOutput.send([144, 1, 0]); } 
    else {
      if (this.pausedAt === 0) { this.cuePoint = 0; this.jogScrubbed = false; } 
      else { this.seekTo(this.jogScrubbed ? (this.cuePoint = this.pausedAt) : this.cuePoint); }
      this.jogScrubbed = false; this.isStuttering = true; this.play(); playBtn.innerText = "PAUSE";
    }
  }

  releaseCue() {
    if(this.midiOutput) this.midiOutput.send([144, 2, 0]); 
    if (this.isStuttering) { 
      this.pause(); this.seekTo(this.cuePoint); this.updateDisplay(); this.isStuttering = false; 
      this.shadowRoot.getElementById('playBtn').innerText = "▶||"; 
      if(this.midiOutput) this.midiOutput.send([144, 1, 0]);
    }
  }

  // ========================================================
  // === МАТРИЦА СИГНАЛОВ DENON LC6000 ===
  // ========================================================

  handleMIDIMessage(event) {
    const [status, id, value] = event.data;
    const log = this.shadowRoot.getElementById('midiConsoleLog');
    log.innerText = `IN: [${status}, ${id}, ${value}]`; 

    const isNoteOn = (status === 144 && value > 0);
    const isNoteOff = (status === 128 || (status === 144 && value === 0));

    // 1. ТРАНСПОРТ
    if (id === 1 && isNoteOn) { this.togglePlay(); return; }
    if (id === 2) {
      if (isNoteOn) this.pressCue();
      if (isNoteOff) this.releaseCue();
      return;
    }

    // 2. ВЕРХНЯЯ ТАРЕЛКА ДЖОГА (Нота №40 [0x28])
    if (id === 40 && (status === 144 || status === 128)) {
      const mode = this.jogModes[this.currentJogMode];

      if (isNoteOn) {
        this._isPlatterTouched = true;
        if (mode === 'VINYL') {
          if (this.isPlaying) {
            this._wasPlayingBeforePlatter = true;
            this.pause(); // Глушим мотор мгновенно
          } else {
            this._wasPlayingBeforePlatter = false;
          }
        } else if (mode === 'CDJ') {
          if (!this.isPlaying) this.startCdjStutter();
        }
      }

      if (isNoteOff) {
        this._isPlatterTouched = false;
        if (mode === 'VINYL' && this._wasPlayingBeforePlatter) {
          this.play(); // Отпустили руку — мотор поехал дальше
        } else if (mode === 'CDJ') {
          // В CDJ при отпускании НЕ останавливаем заикание (ТЗ выполнено!)
        }
      }
      return;
    }

    // 3. ПИТЧ-ФЕЙДЕР (14 БИТ: MSB=8, LSB=40)
    if (status === 176 && (id === 8 || id === 40)) {
      if (id === 8)  this._pitchMSB = value;
      if (id === 40) this._pitchLSB = value;

      if (this._pitchMSB !== undefined && this._pitchLSB !== undefined) {
        const raw14 = (this._pitchMSB << 7) | this._pitchLSB;
        const maxP = this.pitchRanges[this.currentPitchRangeIdx];
        this.pitch = ((raw14 / 16383) * 2 - 1) * maxP;
        
        this.applyPlaybackRate(); 
        this.updatePitchUI();
        if (!this.isPlaying) this.updateDisplay();
      }
      return;
    }

    // === 4. ДЖОГ (ОТНОСИТЕЛЬНЫЙ ЭНКОДЕР: CC 54 [0x36]) ===
    if (status === 176 && id === 54) {
      const delta = value <= 63 ? value : value - 128;
      if (delta === 0 || !this.buffer) return;

      const mode = this.jogModes[this.currentJogMode];

      if (this._isPlatterTouched) {
        // --- РУКА НА МЕТАЛЛЕ СВЕРХУ ---
        if (mode === 'VINYL') {
          this.executeScrubStep(delta * 0.003); // Царапаем
        } else if (mode === 'CDJ') {
          if (this.isPlaying) {
            this.nudgeMotor(delta * 0.02); // В игре — питч-бенд
          } else {
            this.executeScrubStep(delta * 0.0015); // На паузе — двигаем точку заикания
            this.updateCdjStutter();
          }
        } else if (mode === 'CTRL') {
          this.executeScrubStep(delta * 0.02); // Быстрый поиск х6
        }
      } else {
        // --- КРУТИМ ЗА БОК (ПЛАСТИКОВОЕ КОЛЬЦО) ---
        if (this.isPlaying) {
          this.nudgeMotor(delta * 0.015); // Питч-бенд в игре
        } else {
          if (mode === 'VINYL' || mode === 'CDJ') {
            this.executeScrubStep(delta * 0.003); // Тихая перемотка/царапание
          } else if (mode === 'CTRL') {
            this.executeScrubStep(delta * 0.0015); // Медленный, ювелирный поиск
          }
        }
      }
      return;
    }

    // 5. КНОПКИ PITCH BEND (+ / -)
    if (isNoteOn && (id === 24 || id === 25 || id === 23)) {
      const bend = (id === 24) ? -0.04 : 0.04;
      this.applyPlaybackRate(bend);
      return;
    }
    if (isNoteOff && (id === 24 || id === 25 || id === 23)) {
      this.applyPlaybackRate(0);
      return;
    }
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
    const pVal = this.shadowRoot.getElementById('pValDisplay'); const pUp = this.shadowRoot.getElementById('pDirUp');
    const pDown = this.shadowRoot.getElementById('pDirDown'); const pZero = this.shadowRoot.getElementById('pZeroLED');
    pVal.innerText = (this.pitch > 0 ? "+" : "") + this.pitch.toFixed(2) + "%";
    pUp.className = 'pitch-dir'; pDown.className = 'pitch-dir'; pZero.className = 'pitch-zero';
    if (Math.abs(this.pitch) < 0.01) { pZero.classList.add('lit-zero'); pVal.style.color = '#fff'; } 
    else { pZero.style.color = '#222'; pVal.style.color = '#00f0ff'; if (!this.pitchInvert) { if (this.pitch > 0) pDown.classList.add('lit-plus'); else pUp.classList.add('lit-minus'); } else { if (this.pitch > 0) pUp.classList.add('lit-plus'); else pDown.classList.add('lit-minus'); } }
  }

  formatTime(seconds) {
    if (isNaN(seconds)) return "0:00.0";
    const min = Math.floor(Math.abs(seconds) / 60); const sec = Math.floor(Math.abs(seconds) % 60); const ms = Math.floor((Math.abs(seconds) * 10) % 10);
    return `${seconds < 0 ? "-" : ""}${min}:${sec.toString().padStart(2, '0')}.${ms}`;
  }

  getCurrentTime() {
    return this.pausedAt; // Мгновенно синхронизируется ворклетом
  }

  async detectKeyDSP(buffer) { /* DSP алгоритм без изменений */ return "---"; }

  extractID3(buffer) {
    const view = new Uint8Array(buffer.slice(0, 4096)); let str = '';
    for (let i = 0; i < view.length; i++) str += String.fromCharCode(view[i]);
    let detectedKey = null; let detectedBpm = null;
    const tkey = str.indexOf('TKEY'); if (tkey !== -1) { const c = str.substring(tkey+11, tkey+18).replace(/[^\w#/]/g, '').trim(); if (c.length >= 2) detectedKey = c; }
    const tbpm = str.indexOf('TBPM'); if (tbpm !== -1) { const f = parseFloat(str.substring(tbpm+11, tbpm+18).replace(/[^\d.]/g, '')); if (!isNaN(f) && f > 40 && f < 250) detectedBpm = f; }
    return { detectedKey, detectedBpm };
  }

  buildWavePeaks() {
    if (!this.buffer) return;
    const rawData = this.buffer.getChannelData(0); 
    const samplesPerPeak = Math.floor(this.buffer.sampleRate / this.peaksPerSecFixed);
    this.wavePeaks = [];
    for (let i = 0; i < rawData.length; i += samplesPerPeak) {
      let max = 0;
      for (let j = 0; j < samplesPerPeak && (i + j) < rawData.length; j++) if (Math.abs(rawData[i+j]) > max) max = Math.abs(rawData[i+j]);
      this.wavePeaks.push(max);
    }
  }

  analyzeBeatgrid(id3Bpm) {
    let maxP = 0; for (let p of this.wavePeaks) if (p > maxP) maxP = p;
    const threshold = maxP * 0.55; const beats = [];
    for (let i = 0; i < this.wavePeaks.length; i++) { if (this.wavePeaks[i] > threshold) { beats.push(i); i += 25; } }
    if (beats.length < 4) { this.bpm = id3Bpm || 128.00; this.gridOffset = 0.0; return; }
    this.gridOffset = beats[0] / this.peaksPerSecFixed;
    if (id3Bpm) { this.bpm = id3Bpm; return; }
    const intervals = {};
    for (let i = 1; i < Math.min(beats.length, 150); i++) {
      const delta = beats[i] - beats[i - 1]; const bpmCalc = Math.round((this.peaksPerSecFixed / delta) * 60);
      if (bpmCalc >= 70 && bpmCalc <= 180) intervals[bpmCalc] = (intervals[bpmCalc] || 0) + 1;
    }
    let guessedBpm = 128.00; let maxCount = 0;
    for (let b in intervals) { if (intervals[b] > maxCount) { maxCount = intervals[b]; guessedBpm = parseFloat(b); } }
    if (guessedBpm < 85) guessedBpm *= 2; 
    this.bpm = guessedBpm;
  }

  drawWaveform() {
    if (!this.wavePeaks.length || !this.waveCtx) return;
    const ctx = this.waveCtx; const wrap = this.shadowRoot.getElementById('canvasWrap');
    const cssWidth = wrap.clientWidth || 380; const cssHeight = wrap.clientHeight || 75;
    const halfH = cssHeight / 2; const needleX = cssWidth / 2; 

    ctx.clearRect(0, 0, cssWidth, cssHeight);
    const currentTime = this.getCurrentTime(); const playbackRate = 1 + (this.pitch / 100);
    const effectivePps = this.pixelsPerSecond / playbackRate; 
    
    const viewSecHalf = needleX / effectivePps;
    const startTime = currentTime - viewSecHalf; const endTime = currentTime + viewSecHalf;
    const startIdx = Math.max(0, Math.floor(startTime * this.peaksPerSecFixed));
    const endIdx = Math.min(this.wavePeaks.length - 1, Math.ceil(endTime * this.peaksPerSecFixed));
    const step = Math.max(1, Math.floor((endIdx - startIdx) / (cssWidth * 1.5))); 

    ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = this.waveGradient; 
    ctx.beginPath();
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

    if (this.cuePoint >= 0 && (this.cuePoint > 0 || this.jogScrubbed === false)) {
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

  updateDisplay = () => {
    if (!this.buffer) return; const current = this.getCurrentTime();
    if (!this.isLooping && current >= this.buffer.duration) { this.pause(); this.seekTo(0); }
    
    const remaining = this.buffer.duration - current;
    this.shadowRoot.getElementById('timeElapsed').innerText = this.formatTime(current);
    this.shadowRoot.getElementById('timeRemaining').innerText = "-" + this.formatTime(remaining);
    const effectiveBpm = this.bpm * (1 + (this.pitch / 100));
    this.shadowRoot.getElementById('bpmDisplay').innerText = effectiveBpm.toFixed(2);
    const progress = current / this.buffer.duration; const activeSegments = Math.ceil((1 - progress) * 64);
    this.segments.forEach((seg, idx) => { seg.style.opacity = idx < activeSegments ? '1' : '0.1'; seg.style.background = idx < activeSegments ? '#00f0ff' : '#fff'; });
    if (this.jogMarker) this.jogMarker.style.transform = `rotate(${((current * (360 / 1.8)) % 360)}deg)`;
    this.drawWaveform(); 
    if (this.isPlaying) this.animationFrame = requestAnimationFrame(this.updateDisplay);
  }

  applyPlaybackRate(customBend = 0) { 
    if (!this.workletNode) return;
    const finalSpeed = (1 + (this.pitch / 100)) + customBend;
    this.workletNode.port.postMessage({ type: 'set_rate', rate: finalSpeed });
  }

  applyLoop() { 
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({
      type: 'set_loop', isLooping: this.isLooping,
      loopIn: this.loopIn || 0, loopOut: this.loopOut || 0
    });
  }

  startCdjStutter() { 
    this.isCdjStuttering = true;
    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: 'set_loop', isLooping: true,
        loopIn: this.pausedAt, loopOut: this.pausedAt + 0.085
      });
      this.workletNode.port.postMessage({ type: 'play' });
    }
  }

  updateCdjStutter() { 
    if (this.isCdjStuttering && this.workletNode) {
      this.workletNode.port.postMessage({
        type: 'set_loop', isLooping: true,
        loopIn: this.pausedAt, loopOut: this.pausedAt + 0.085
      });
    }
  }

  stopCdjStutter() { 
    if (this.isCdjStuttering && this.workletNode) {
      this.isCdjStuttering = false;
      this.workletNode.port.postMessage({ type: 'pause' });
      this.applyLoop(); // Восстанавливаем оригинальную петлю
    }
  }

  initScrubEngine(sourceName) { return true; }
  releaseScrubEngine(sourceName) {}

  executeScrubStep(deltaSec) {
    if (!this.workletNode || !this.buffer) return;
    this.workletNode.port.postMessage({ type: 'scrub', deltaSec: deltaSec });
    this.pausedAt = Math.max(0, Math.min(this.buffer.duration, this.pausedAt + deltaSec));
    this.updateDisplay();
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = this.getTemplate();
    const fileInput = this.shadowRoot.getElementById('fileInput'); const playBtn = this.shadowRoot.getElementById('playBtn');
    const cueBtn = this.shadowRoot.getElementById('cueBtn'); const resetBtn = this.shadowRoot.getElementById('resetBtn');
    const trackTitleDisplay = this.shadowRoot.getElementById('trackTitleDisplay'); const ring = this.shadowRoot.getElementById('progressRing');
    const pitchBox = this.shadowRoot.getElementById('pitchBox'); const bendMinus = this.shadowRoot.getElementById('bendMinus');
    const bendPlus = this.shadowRoot.getElementById('bendPlus'); const loopInBtn = this.shadowRoot.getElementById('loopInBtn');
    const loopOutBtn = this.shadowRoot.getElementById('loopOutBtn'); const loopMinus = this.shadowRoot.getElementById('loopMinus');
    const loopPlus = this.shadowRoot.getElementById('loopPlus'); const loopSizeDisplay = this.shadowRoot.getElementById('loopSizeDisplay');
    const jogWheel = this.shadowRoot.getElementById('jogWheel'); const jogModeBtn = this.shadowRoot.getElementById('jogModeBtn');
    const mtBtn = this.shadowRoot.getElementById('mtBtn'); this.jogMarker = this.shadowRoot.getElementById('jogMarker');
    const canvasWrap = this.shadowRoot.getElementById('canvasWrap'); const waveCanvas = this.shadowRoot.getElementById('waveCanvas');
    const wZoomOut = this.shadowRoot.getElementById('wZoomOut'); const wZoomIn = this.shadowRoot.getElementById('wZoomIn');
    const gridSetBtn = this.shadowRoot.getElementById('gridSetBtn');
    const pRangeBtn = this.shadowRoot.getElementById('pRangeBtn'); const pInvBtn = this.shadowRoot.getElementById('pInvBtn');
    
    const midiConnectBtn = this.shadowRoot.getElementById('midiConnectBtn');

    for (let i = 0; i < 64; i++) { const seg = document.createElement('div'); seg.className = 'progress-segment'; seg.style.transform = `rotate(${i * (360 / 64)}deg)`; ring.appendChild(seg); }
    this.segments = this.shadowRoot.querySelectorAll('.progress-segment');

    const setupCanvas = () => {
      const rect = canvasWrap.getBoundingClientRect(); if (rect.width === 0) return; 
      const dpr = window.devicePixelRatio || 1; waveCanvas.width = rect.width * dpr; waveCanvas.height = rect.height * dpr;
      const ctx = waveCanvas.getContext('2d'); ctx.scale(dpr, dpr); this.waveCanvas = waveCanvas; this.waveCtx = ctx;
      const grad = ctx.createLinearGradient(0, 0, 0, rect.height);
      grad.addColorStop(0.0, '#ff2200'); grad.addColorStop(0.25, '#ffaa00'); grad.addColorStop(0.4, '#00ff44'); grad.addColorStop(0.5, '#0088ff');
      grad.addColorStop(0.6, '#00ff44'); grad.addColorStop(0.75, '#ffaa00'); grad.addColorStop(1.0, '#ff2200');
      this.waveGradient = grad; if (this.buffer) this.drawWaveform();
    }; setTimeout(setupCanvas, 100); window.addEventListener('resize', setupCanvas);

    const bindSnappy = (el, onHit, onRelease = null) => {
      let isTouched = false;
      const hitHandler = (e) => { if (e.type === 'touchstart') isTouched = true; if (e.type === 'mousedown' && isTouched) return; if (e.cancelable) e.preventDefault(); e.stopPropagation(); onHit(e); };
      el.addEventListener('touchstart', hitHandler, { passive: false }); el.addEventListener('mousedown', hitHandler);
      if (onRelease) {
        const releaseHandler = (e) => { if (e.type === 'mouseup' && isTouched) return; if (e.cancelable) e.preventDefault(); e.stopPropagation(); onRelease(e); };
        el.addEventListener('touchend', releaseHandler, { passive: false }); el.addEventListener('touchcancel', releaseHandler, { passive: false }); el.addEventListener('mouseup', releaseHandler); el.addEventListener('mouseleave', releaseHandler);
      }
    };

    bindSnappy(midiConnectBtn, () => this.initWebMIDI());
    bindSnappy(wZoomOut, () => { this.pixelsPerSecond = Math.max(1.5, Math.min(400, this.pixelsPerSecond * 0.75)); this.updateDisplay(); });
    bindSnappy(wZoomIn, () => { this.pixelsPerSecond = Math.max(1.5, Math.min(400, this.pixelsPerSecond * 1.33)); this.updateDisplay(); });
    bindSnappy(gridSetBtn, () => { if (!this.buffer) return; this.gridOffset = this.getCurrentTime(); this.updateDisplay(); if (navigator.vibrate) navigator.vibrate(30); });

    let waveFrameStartX = 0; let isPinching = false;
    canvasWrap.addEventListener('pointerdown', (e) => { if (!this.buffer || isPinching) return; if (this.initScrubEngine('WAVE')) { waveFrameStartX = e.clientX; try { canvasWrap.setPointerCapture(e.pointerId); } catch(err){} } });
    canvasWrap.addEventListener('pointermove', (e) => { if (this.activeScrubber !== 'WAVE' || isPinching) return; const deltaX = e.clientX - waveFrameStartX; waveFrameStartX = e.clientX; const effectivePps = this.pixelsPerSecond / (1 + (this.pitch / 100)); this.executeScrubStep(-deltaX / effectivePps); });
    const stopWave = (e) => { this.releaseScrubEngine('WAVE'); try { canvasWrap.releasePointerCapture(e.pointerId); } catch(err){} };
    canvasWrap.addEventListener('pointerup', stopWave); canvasWrap.addEventListener('pointercancel', stopWave);

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0]; if (!file) return; trackTitleDisplay.innerText = "READING ID3..."; window.AppCore.initAudio(); 
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const arrayBuf = ev.target.result; const meta = this.extractID3(arrayBuf);
        this.keyStr = meta.detectedKey || "---";

        trackTitleDisplay.innerText = "DECODING...";
        this.buffer = await window.AppCore.audioCtx.decodeAudioData(arrayBuf); 
        trackTitleDisplay.innerText = "LOADING RESAMPLER...";

        await this.setupAudioEngine();
        if (this.workletNode) {
          const left = this.buffer.getChannelData(0);
          const right = this.buffer.numberOfChannels > 1 ? this.buffer.getChannelData(1) : left;
          this.workletNode.port.postMessage({
            type: 'load', left: left, right: right, sampleRate: this.buffer.sampleRate
          });
        }

        trackTitleDisplay.innerText = "ANALYZING TRANSIENTS...";
        this.buildWavePeaks(); this.analyzeBeatgrid(meta.detectedBpm);

        this.shadowRoot.getElementById('keyDisplay').innerText = this.keyStr;
        this.shadowRoot.getElementById('bpmDisplay').innerText = this.bpm.toFixed(2);

        if (this.midiOutput) {
          this.midiOutput.send([144, 1, 127]); 
          this.midiOutput.send([144, 2, 127]); 
        }

        trackTitleDisplay.innerText = file.name; this.stopCdjStutter(); this.seekTo(0); this.cuePoint = 0; this.jogScrubbed = false; this.loopIn = null; this.loopOut = null; this.isLooping = false; loopInBtn.className = ''; loopOutBtn.className = ''; loopSizeDisplay.style.color = '#fff'; this.updateDisplay();
      }; reader.readAsArrayBuffer(file);
    });

    jogModeBtn.addEventListener('click', () => {
      this.currentJogMode = (this.currentJogMode + 1) % this.jogModes.length; const mode = this.jogModes[this.currentJogMode]; jogModeBtn.innerText = mode;
      if (mode === 'CTRL') { jogModeBtn.style.background = '#00aaff'; jogModeBtn.style.color = '#000'; } else if (mode === 'CDJ') { jogModeBtn.style.background = '#ff8c00'; jogModeBtn.style.color = '#000'; } else { jogModeBtn.style.background = '#ff0055'; jogModeBtn.style.color = '#fff'; }
    });
    mtBtn.addEventListener('click', () => { this.masterTempo = !this.masterTempo; mtBtn.style.background = this.masterTempo ? '#00ff00' : '#222'; mtBtn.style.color = this.masterTempo ? '#000' : '#888'; });

    bindSnappy(pRangeBtn, () => {
      this.currentPitchRangeIdx = (this.currentPitchRangeIdx + 1) % this.pitchRanges.length; const maxP = this.pitchRanges[this.currentPitchRangeIdx]; pRangeBtn.innerText = `±${maxP}%`;
      if (this.pitch > maxP) this.pitch = maxP; if (this.pitch < -maxP) this.pitch = -maxP; this.applyPlaybackRate(); this.updatePitchUI(); if (!this.isPlaying) this.updateDisplay();
    });
    bindSnappy(pInvBtn, () => {
      this.pitchInvert = !this.pitchInvert; pInvBtn.innerText = this.pitchInvert ? "INV: ON" : "INV: OFF"; pInvBtn.style.color = this.pitchInvert ? "#ff0055" : "#aaa"; this.updatePitchUI();
    });

    let pitchTapTime = 0;
    pitchBox.addEventListener('pointerdown', (e) => { const now = Date.now(); if (now - pitchTapTime < 300) { this.pitch = 0.0; if (navigator.vibrate) navigator.vibrate(50); this.applyPlaybackRate(); this.updatePitchUI(); if (!this.isPlaying) this.updateDisplay(); pitchTapTime = 0; return; } pitchTapTime = now; this.startY = e.clientY; this.basePitch = this.pitch; });
    pitchBox.addEventListener('pointermove', (e) => { 
      if (e.buttons !== 1) return; const deltaY = e.clientY - this.startY; if (Math.abs(deltaY) > 2) pitchTapTime = 0; 
      const maxP = this.pitchRanges[this.currentPitchRangeIdx]; const sensitivity = maxP / 150; 
      let newPitch = this.pitchInvert ? this.basePitch - (deltaY * sensitivity) : this.basePitch + (deltaY * sensitivity); 
      newPitch = Math.max(-maxP, Math.min(maxP, newPitch)); 
      this.pitch = newPitch; this.applyPlaybackRate(); this.updatePitchUI(); if (!this.isPlaying) this.updateDisplay(); 
    });

    this.updatePitchUI();

    const updateLoopUi = () => { const val = this.loopSizes[this.currentLoopIdx]; loopSizeDisplay.innerText = this.getLoopSizeStr(val); if (this.isLooping && this.loopIn !== null) { this.loopOut = this.loopIn + ((60 / this.bpm) * val); this.applyLoop(); } }; updateLoopUi();
    bindSnappy(loopMinus, () => { if (this.currentLoopIdx > 0) { this.currentLoopIdx--; updateLoopUi(); }}); bindSnappy(loopPlus, () => { if (this.currentLoopIdx < this.loopSizes.length - 1) { this.currentLoopIdx++; updateLoopUi(); }});
    bindSnappy(loopSizeDisplay, () => { if (!this.buffer) return; window.AppCore.initAudio(); if (this.isLooping) { this.isLooping = false; this.loopIn = null; this.loopOut = null; this.applyLoop(); loopInBtn.className = ''; loopOutBtn.className = ''; loopSizeDisplay.style.color = '#fff'; } else { this.loopIn = this.getCurrentTime(); this.loopOut = this.loopIn + ((60 / this.bpm) * this.loopSizes[this.currentLoopIdx]); this.isLooping = true; this.applyLoop(); loopInBtn.className = 'loop-active-loop'; loopOutBtn.className = 'loop-active-loop'; loopSizeDisplay.style.color = '#ff8c00'; } });
    bindSnappy(loopInBtn, () => { if (!this.buffer) return; window.AppCore.initAudio(); this.isLooping = false; this.applyLoop(); this.loopIn = this.getCurrentTime(); this.loopOut = null; loopInBtn.className = 'loop-active-in'; loopOutBtn.className = ''; loopSizeDisplay.style.color = '#fff'; });
    bindSnappy(loopOutBtn, () => { if (!this.buffer || this.loopIn === null) return; if (this.isLooping) { this.isLooping = false; this.loopIn = null; this.loopOut = null; this.applyLoop(); loopInBtn.className = ''; loopOutBtn.className = ''; loopSizeDisplay.style.color = '#fff'; } else { const cur = this.getCurrentTime(); if (cur > this.loopIn) { this.loopOut = cur; this.isLooping = true; this.applyLoop(); loopInBtn.className = 'loop-active-loop'; loopOutBtn.className = 'loop-active-loop'; } } });
    bindSnappy(bendMinus, () => { window.AppCore.initAudio(); this.applyPlaybackRate(-0.04); }, () => this.applyPlaybackRate(0)); bindSnappy(bendPlus, () => { window.AppCore.initAudio(); this.applyPlaybackRate(0.04); }, () => this.applyPlaybackRate(0));
    bindSnappy(playBtn, () => this.togglePlay());
    bindSnappy(resetBtn, () => { this.pause(); this.seekTo(0); });
    bindSnappy(cueBtn, () => this.pressCue(), () => this.releaseCue());
  }

  play() { 
    if (this.isPlaying || !this.buffer || !this.workletNode) return; 
    this.workletNode.port.postMessage({ type: 'play' });
    this.isPlaying = true; 
    this.applyPlaybackRate(); 
    this.updateDisplay(); 
  }

  pause() { 
    if (!this.isPlaying || !this.workletNode) return; 
    this.workletNode.port.postMessage({ type: 'pause' });
    this.isPlaying = false; 
    cancelAnimationFrame(this.animationFrame); 
  }
}
customElements.define('dj-deck', DjDeck);
