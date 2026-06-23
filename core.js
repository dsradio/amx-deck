class EventBus {
  constructor() {
    this.listeners = {};
    this.audioCtx = null;
  }
  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }
  emit(event, data) {
    if (!this.listeners[event]) return;
    this.listeners[event].forEach(cb => cb(data));
  }
  // Включение звукового движка (нужен первый тап пользователя)
  initAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      alert("Звуковой движок Ядра активирован!");
    }
  }
}
window.AppCore = new EventBus();

// Ядро слушает команду от кнопки PLAY
window.AppCore.on('deck_play', (data) => {
  window.AppCore.initAudio(); 
  console.log(`Ядро: запущен трек на деке ${data.deckId}`);
});
