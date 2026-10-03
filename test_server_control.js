/**
 * Unit tests for TeleprompterServerControl module using Node.js built-in test runner.
 * Run with: node test_server_control.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const ServerControlModule = require('./static/server_control.js');

function createMockElement(initialClasses = []) {
  const classes = new Set(initialClasses);
  const listeners = {};
  const children = [];

  const el = {
    textContent: '',
    innerHTML: '',
    className: '',
    children,
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (name) => classes.has(name),
    },
    addEventListener: (evt, fn) => {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(fn);
    },
    dispatchEvent: (evt, payload = {}) => {
      (listeners[evt] || []).forEach((fn) => fn(payload));
    },
    querySelector: (selector) => {
      // Mock selector lookup for child buttons
      if (selector === '#btn-server-modal-cancel') {
        const btn = createMockElement();
        el._mockCancel = btn;
        return btn;
      }
      if (selector === '#btn-server-modal-confirm-restart') {
        const btn = createMockElement();
        el._mockConfirmRestart = btn;
        return btn;
      }
      if (selector === '#btn-server-modal-confirm-shutdown') {
        const btn = createMockElement();
        el._mockConfirmShutdown = btn;
        return btn;
      }
      return null;
    },
    click: () => {
      (listeners['click'] || []).forEach((fn) => fn({ target: el }));
    },
  };
  return el;
}

describe('TeleprompterServerControl - Lifecycle & Dialog States', () => {
  const { TeleprompterServerControl } = ServerControlModule;

  test('initializes with IDLE state and modal closed', () => {
    const modalEl = createMockElement(['hidden']);
    const control = new TeleprompterServerControl({ modalEl });

    assert.equal(control.isOpen(), false);
    assert.equal(control.isRestarting, false);
    assert.equal(control.isShutDown, false);
    assert.equal(control.canDismiss(), true);
  });

  test('showRestartConfirm opens modal and sets confirmation title and buttons', () => {
    const modalEl = createMockElement(['hidden']);
    const titleEl = createMockElement();
    const descEl = createMockElement();
    const footerEl = createMockElement();
    const iconEl = createMockElement();

    let restarted = false;
    const control = new TeleprompterServerControl({
      modalEl,
      titleEl,
      descEl,
      footerEl,
      iconEl,
      onRestart: () => { restarted = true; },
    });

    control.showRestartConfirm();

    assert.equal(control.isOpen(), true);
    assert.equal(control.state, 'CONFIRM_RESTART');
    assert.ok(titleEl.textContent.includes('Restart'));
    assert.ok(descEl.innerHTML.includes('reconnect automatically'));
    assert.ok(footerEl.innerHTML.includes('Restart Server'));

    // Trigger confirmation click
    footerEl._mockConfirmRestart.click();
    assert.equal(restarted, true);
    assert.equal(control.isRestarting, true);
    assert.equal(control.state, 'RESTARTING');
    assert.equal(control.canDismiss(), false);
  });

  test('showShutdownConfirm opens modal and sets shutdown prompt', () => {
    const modalEl = createMockElement(['hidden']);
    const titleEl = createMockElement();
    const descEl = createMockElement();
    const footerEl = createMockElement();
    const iconEl = createMockElement();

    let shutDown = false;
    const control = new TeleprompterServerControl({
      modalEl,
      titleEl,
      descEl,
      footerEl,
      iconEl,
      onShutdown: () => { shutDown = true; },
    });

    control.showShutdownConfirm();

    assert.equal(control.isOpen(), true);
    assert.equal(control.state, 'CONFIRM_SHUTDOWN');
    assert.ok(titleEl.textContent.includes('Shut Down'));
    assert.ok(descEl.innerHTML.includes('./run.sh'));

    footerEl._mockConfirmShutdown.click();
    assert.equal(shutDown, true);
    assert.equal(control.isShutDown, true);
    assert.equal(control.state, 'SHUTDOWN');
    assert.equal(control.canDismiss(), false);
  });

  test('dismissal prevention when restarting or shut down', () => {
    const modalEl = createMockElement(['hidden']);
    const control = new TeleprompterServerControl({ modalEl });

    control.showRestartingState();
    assert.equal(control.isOpen(), true);
    assert.equal(control.canDismiss(), false);

    // Standard close should be ignored
    control.close();
    assert.equal(control.isOpen(), true);

    // Force close succeeds
    control.close(true);
    assert.equal(control.isOpen(), false);
  });

  test('handleServerStopping handles both restart and shutdown actions', () => {
    const modalEl = createMockElement(['hidden']);
    const titleEl = createMockElement();
    const descEl = createMockElement();
    const footerEl = createMockElement();
    const iconEl = createMockElement();

    const control = new TeleprompterServerControl({
      modalEl,
      titleEl,
      descEl,
      footerEl,
      iconEl,
    });

    control.handleServerStopping('restart');
    assert.equal(control.isRestarting, true);
    assert.equal(control.state, 'RESTARTING');
    assert.ok(titleEl.textContent.includes('Restarting'));

    control.handleServerStopping('shutdown');
    assert.equal(control.isShutDown, true);
    assert.equal(control.state, 'SHUTDOWN');
    assert.ok(titleEl.textContent.includes('Server Shut Down'));
  });

  test('handleReconnected resets restarting state, closes modal, and triggers toast', () => {
    const modalEl = createMockElement();
    let toastMessage = null;

    const control = new TeleprompterServerControl({
      modalEl,
      onToast: (msg) => { toastMessage = msg; },
    });

    control.isRestarting = true;
    control.handleReconnected();

    assert.equal(control.isRestarting, false);
    assert.equal(control.isOpen(), false);
    assert.ok(toastMessage && toastMessage.includes('Server reconnected'));
  });

  test('backdrop click dismisses modal only when canDismiss is true', () => {
    const modalEl = createMockElement();
    const control = new TeleprompterServerControl({ modalEl });

    // In idle / open state, clicking modal background closes it
    control.modalEl.dispatchEvent('click', { target: modalEl });
    assert.equal(control.isOpen(), false);

    // In restarting state, clicking background does not close it
    control.showRestartingState();
    assert.equal(control.isOpen(), true);
    control.modalEl.dispatchEvent('click', { target: modalEl });
    assert.equal(control.isOpen(), true);
  });
});

describe('TeleprompterServerControl - Global / Browser Export Compatibility', () => {
  test('supports direct constructor instantiation from module or global export', () => {
    const fs = require('fs');
    const vm = require('vm');
    const code = fs.readFileSync('./static/server_control.js', 'utf8');

    // Simulate browser environment where module and exports are undefined
    const browserContext = {
      self: {},
      console,
    };
    browserContext.globalThis = browserContext.self;
    vm.createContext(browserContext);
    vm.runInContext(code, browserContext);

    const GlobalClass = browserContext.self.TeleprompterServerControl;
    assert.equal(typeof GlobalClass, 'function', 'TeleprompterServerControl must be a constructor function on global scope');

    // Verify new TeleprompterServerControl(...) works directly
    const instance1 = new GlobalClass({ modalEl: createMockElement() });
    assert.ok(instance1 instanceof GlobalClass);

    // Verify new TeleprompterServerControl.TeleprompterServerControl(...) also works
    assert.equal(typeof GlobalClass.TeleprompterServerControl, 'function');
    const instance2 = new GlobalClass.TeleprompterServerControl({ modalEl: createMockElement() });
    assert.ok(instance2 instanceof GlobalClass);
  });
});
