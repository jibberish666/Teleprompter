/**
 * TeleprompterServerControl - Server Lifecycle & Action Modal Controller.
 *
 * Encapsulates:
 * 1. Modal visibility lifecycle for server restart & shutdown confirmation flows
 * 2. Visual states (confirmation prompt, in-progress spinner, terminal shutdown screen)
 * 3. Safe dismissal boundaries (cannot dismiss while restart is in progress or server is shut down)
 * 4. WebSocket reconnect lifecycle synchronization
 * 5. Status pill state presentation
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node.js / CommonJS
    module.exports = factory(root);
  } else {
    // Browser global
    root.TeleprompterServerControl = factory(root);
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  // Fallback SVG icons if HTML <template> elements are not present
  const ICONS = {
    restart: '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>',
    shutdown: '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 4.243a9 9 0 01-6.364-2.636 9 9 0 010-12.728m0 0l2.829 2.829M12 3v9"/></svg>',
    spinner: '<svg class="w-6 h-6 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>',
    check: '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>',
  };

  const STYLES = {
    amberIcon: 'w-12 h-12 mx-auto rounded-full bg-amber-500/20 border border-amber-400/40 flex items-center justify-center text-amber-400',
    redIcon: 'w-12 h-12 mx-auto rounded-full bg-red-500/20 border border-red-400/40 flex items-center justify-center text-red-400',
  };

  class TeleprompterServerControl {
    constructor(options = {}) {
      this.modalEl = options.modalEl || (typeof document !== 'undefined' ? document.getElementById('modal-server-action') : null);
      this.iconEl = options.iconEl || (typeof document !== 'undefined' ? document.getElementById('server-action-icon') : null);
      this.titleEl = options.titleEl || (typeof document !== 'undefined' ? document.getElementById('server-action-title') : null);
      this.descEl = options.descEl || (typeof document !== 'undefined' ? document.getElementById('server-action-desc') : null);
      this.footerEl = options.footerEl || (typeof document !== 'undefined' ? document.getElementById('server-action-footer') : null);

      this.btnRestartTrigger = options.btnRestartTrigger || (typeof document !== 'undefined' ? document.getElementById('btn-restart-server') : null);
      this.btnShutdownTrigger = options.btnShutdownTrigger || (typeof document !== 'undefined' ? document.getElementById('btn-shutdown-server') : null);
      this.serverStatusPill = options.serverStatusPill || (typeof document !== 'undefined' ? document.getElementById('server-status-pill') : null);

      this.onRestart = options.onRestart || null;
      this.onShutdown = options.onShutdown || null;
      this.onToast = options.onToast || null;

      this.isRestarting = false;
      this.isShutDown = false;
      this.state = 'IDLE'; // 'IDLE' | 'CONFIRM_RESTART' | 'CONFIRM_SHUTDOWN' | 'RESTARTING' | 'SHUTDOWN'

      this.initEventListeners();
    }

    initEventListeners() {
      if (this.btnRestartTrigger) {
        this.btnRestartTrigger.addEventListener('click', () => this.showRestartConfirm());
      }
      if (this.btnShutdownTrigger) {
        this.btnShutdownTrigger.addEventListener('click', () => this.showShutdownConfirm());
      }
      if (this.modalEl) {
        this.modalEl.addEventListener('click', (e) => {
          if (e.target === this.modalEl && this.canDismiss()) {
            this.close();
          }
        });
      }
    }

    _renderIcon(iconKey) {
      if (!this.iconEl) return;
      if (typeof document !== 'undefined') {
        const tmpl = document.getElementById(`tmpl-icon-${iconKey}`);
        if (tmpl && tmpl.content) {
          this.iconEl.innerHTML = '';
          this.iconEl.appendChild(tmpl.content.cloneNode(true));
          return;
        }
      }
      this.iconEl.innerHTML = ICONS[iconKey] || '';
    }

    isOpen() {
      return Boolean(this.modalEl && !this.modalEl.classList.contains('hidden'));
    }

    canDismiss() {
      return !this.isRestarting && !this.isShutDown;
    }

    close(force = false) {
      if (!this.modalEl) return;
      if (force || this.canDismiss()) {
        this.modalEl.classList.add('hidden');
        if (!this.isRestarting && !this.isShutDown) {
          this.state = 'IDLE';
        }
      }
    }

    showRestartConfirm() {
      if (!this.modalEl) return;
      this.state = 'CONFIRM_RESTART';
      if (this.iconEl) {
        this.iconEl.className = STYLES.amberIcon;
        this._renderIcon('restart');
      }
      if (this.titleEl) {
        this.titleEl.textContent = 'Restart Teleprompter Server?';
      }
      if (this.descEl) {
        this.descEl.innerHTML = 'The Python server will release audio devices, reload speech models, and restart in place. The browser will reconnect automatically.';
      }
      if (this.footerEl) {
        this.footerEl.innerHTML = `
          <button id="btn-server-modal-cancel" type="button" class="px-3.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white font-medium rounded-lg text-xs transition cursor-pointer">Cancel</button>
          <button id="btn-server-modal-confirm-restart" type="button" class="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white font-semibold rounded-lg text-xs transition shadow cursor-pointer">Restart Server</button>
        `;
        const btnCancel = this.footerEl.querySelector('#btn-server-modal-cancel');
        const btnConfirm = this.footerEl.querySelector('#btn-server-modal-confirm-restart');
        if (btnCancel) btnCancel.addEventListener('click', () => this.close());
        if (btnConfirm) btnConfirm.addEventListener('click', () => this.executeRestart());
      }
      this.modalEl.classList.remove('hidden');
    }

    showShutdownConfirm() {
      if (!this.modalEl) return;
      this.state = 'CONFIRM_SHUTDOWN';
      if (this.iconEl) {
        this.iconEl.className = STYLES.redIcon;
        this._renderIcon('shutdown');
      }
      if (this.titleEl) {
        this.titleEl.textContent = 'Shut Down Teleprompter Server?';
      }
      if (this.descEl) {
        this.descEl.innerHTML = 'The server process will terminate completely. To use the teleprompter again later, you will need to restart it from your terminal using <code class="text-indigo-300 font-mono text-xs bg-gray-950 px-1.5 py-0.5 rounded border border-gray-800">./run.sh</code>.';
      }
      if (this.footerEl) {
        this.footerEl.innerHTML = `
          <button id="btn-server-modal-cancel" type="button" class="px-3.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white font-medium rounded-lg text-xs transition cursor-pointer">Cancel</button>
          <button id="btn-server-modal-confirm-shutdown" type="button" class="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white font-semibold rounded-lg text-xs transition shadow cursor-pointer">Shut Down Server</button>
        `;
        const btnCancel = this.footerEl.querySelector('#btn-server-modal-cancel');
        const btnConfirm = this.footerEl.querySelector('#btn-server-modal-confirm-shutdown');
        if (btnCancel) btnCancel.addEventListener('click', () => this.close());
        if (btnConfirm) btnConfirm.addEventListener('click', () => this.executeShutdown());
      }
      this.modalEl.classList.remove('hidden');
    }

    showRestartingState() {
      if (!this.modalEl) return;
      this.isRestarting = true;
      this.state = 'RESTARTING';
      if (this.iconEl) {
        this.iconEl.className = STYLES.amberIcon;
        this._renderIcon('spinner');
      }
      if (this.titleEl) {
        this.titleEl.textContent = 'Restarting Server…';
      }
      if (this.descEl) {
        this.descEl.innerHTML = 'The server is reloading. Reconnecting automatically…';
      }
      if (this.footerEl) {
        this.footerEl.innerHTML = '<span class="text-[11px] text-gray-400 font-mono animate-pulse">Waiting for backend…</span>';
      }
      this.modalEl.classList.remove('hidden');
    }

    showShutdownState() {
      if (!this.modalEl) return;
      this.isShutDown = true;
      this.state = 'SHUTDOWN';
      if (this.iconEl) {
        this.iconEl.className = STYLES.redIcon;
        this._renderIcon('check');
      }
      if (this.titleEl) {
        this.titleEl.textContent = 'Server Shut Down';
      }
      if (this.descEl) {
        this.descEl.innerHTML = 'The local Python server has stopped. You can safely close this browser tab.<br><br>To restart later, run in your terminal:<br><code class="inline-block mt-1 text-indigo-300 font-mono text-xs bg-gray-950 px-2.5 py-1 rounded border border-gray-800">./run.sh</code>';
      }
      if (this.footerEl) {
        this.footerEl.innerHTML = '<span class="text-[11px] text-red-400 font-mono">Process terminated</span>';
      }
      this.modalEl.classList.remove('hidden');
    }

    executeRestart() {
      this.showRestartingState();
      if (typeof this.onRestart === 'function') {
        this.onRestart();
      }
    }

    executeShutdown() {
      this.showShutdownState();
      if (typeof this.onShutdown === 'function') {
        this.onShutdown();
      }
    }

    handleServerStopping(action) {
      if (action === 'restart') {
        this.showRestartingState();
      } else if (action === 'shutdown') {
        this.showShutdownState();
      }
    }

    handleReconnected() {
      if (this.isRestarting) {
        this.isRestarting = false;
        this.close(true);
        if (typeof this.onToast === 'function') {
          this.onToast('Server reconnected ✓');
        }
      }
    }
  }

  TeleprompterServerControl.TeleprompterServerControl = TeleprompterServerControl;
  TeleprompterServerControl.ICONS = ICONS;
  TeleprompterServerControl.STYLES = STYLES;

  return TeleprompterServerControl;
});
