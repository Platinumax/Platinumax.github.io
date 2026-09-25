const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const code = fs.readFileSync(path.join(__dirname, '..', 'vlas.js'), 'utf8');

function setup(options = {}) {
    const listeners = {};
    const settings = [];
    const scripts = [];
    const pushes = [];
    const notices = [];
    const settingsPages = [];
    const timers = [];
    const data = new Map();
    const root = {contains(button) { return button && button.mounted; }};
    const head = {appendChild(script) { scripts.push(script); script.parentNode = head; },
        removeChild(script) { script.parentNode = null; }};
    const document = {documentElement: root, head,
        createElement() { return {}; }};
    let button;
    const anchor = {length: 1, after(next) { button = next; button[0].mounted = true; }};
    const render = {find(selector) {
        if (selector === '.view--torrent') return anchor;
        if (selector === '.view--vlas-filmix') return {length: button ? 1 : 0};
        return {length: 0};
    }};
    function $(html) {
        const element = {0: {mounted: false}, html, length: 1,
            on(event, handler) { this.handler = handler; return this; }};
        return element;
    }
    const lampa = {
        Api: {sources: {tmdb: {main() {}, list() {}, get() {}}}},
        Manifest: {app_digital: options.old ? 154 : 160},
        Listener: {follow(type, handler) { listeners[type] = handler; }},
        SettingsApi: {addComponent() {}, addParam(value) { settings.push(value); },
            getComponent(id) { return id === 'fxapi' && window.online_filmix && !options.partial; }},
        Settings: options.noSettings ? undefined : {create(id, params) {
            settingsPages.push({id, params});
        }},
        Storage: {get(key, fallback) { return data.has(key) ? data.get(key) : fallback; },
            set(key, value) { data.set(key, value); }},
        Activity: {push(item) { pushes.push(item); }},
        Lang: {translate() { return 'Онлайн'; }},
        Noty: {show(value) { notices.push(value); }}
    };
    const window = {Lampa: lampa, online_filmix: !!options.installed};
    vm.runInNewContext(code, {window, Lampa: lampa, $, document,
        setTimeout(fn, delay) {
            const timer = setTimeout(fn, delay);
            timers.push({fn, delay, timer});
            return timer;
        }, clearTimeout, isFinite, Date, Math, JSON, Object},
    {filename: 'vlas.js'});
    function open() {
        button = null;
        listeners.full({type: 'complite', data: {movie: {id: 25,
            title: 'Тестовый фильм', original_title: 'Test movie'}},
        object: {activity: {render() { return render; }}}});
        return button;
    }
    return {open, scripts, pushes, notices, settings, settingsPages, data, window,
        connect() { settings.find(s => s.param.name === 'my_lampa_home_filmix_settings').onChange(); },
        timeout() {
            const t = timers.filter(t => t.delay === 15000).pop();
            clearTimeout(t.timer); t.fn();
        }};
}

const app = setup();
assert.ok(app.settings.some(item => item.param.name === 'my_lampa_home_filmix_button'));
assert.equal(app.scripts.length, 0, 'Filmix must not load on startup');
const button = app.open();
assert.ok(button && button.html.includes('Filmix'));
assert.equal(app.scripts.length, 0, 'Filmix must not load on opening a card');
button.handler();
button.handler();
assert.equal(app.scripts.length, 1, 'Repeated clicks should share one request');
assert.equal(app.scripts[0].src, 'https://lampaplugins.github.io/store/fx.js');
app.window.online_filmix = true;
app.scripts[0].onload();
assert.equal(app.pushes.length, 1);
assert.equal(app.pushes[0].component, 'online_fxapi');
assert.equal(app.pushes[0].movie.id, 25);
assert.equal(app.open(), null, 'Do not duplicate the already installed FX button');

const offline = setup();
const retry = offline.open();
retry.handler();
offline.scripts[0].onerror();
assert.equal(offline.pushes.length, 0);
assert.equal(offline.notices.length, 1);
retry.handler();
assert.equal(offline.scripts.length, 2, 'The user can retry after a failure');
offline.scripts[1].onerror();

const disabled = setup();
disabled.data.set('my_lampa_home_filmix_button', false);
assert.equal(disabled.open(), null);
assert.equal(disabled.scripts.length, 0);

const old = setup({old: true});
old.open().handler();
assert.equal(old.scripts.length, 0);
assert.equal(old.notices.length, 1);

const installed = setup({installed: true});
assert.equal(installed.open(), null);

// Clean install: account entry must exist before any movie is opened or FX installed.
const clean = setup();
const entry = clean.settings.find(s => s.param.name === 'my_lampa_home_filmix_settings');
assert.equal(entry.component, 'my_lampa_home');
assert.equal(entry.field.name, 'Filmix — вход и настройки');
assert.equal(clean.scripts.length, 0);
clean.connect(); clean.connect();
assert.equal(clean.scripts.length, 1, 'Repeated settings clicks duplicated script');
assert.equal(clean.settingsPages.length, 0, 'Settings opened before FX loaded');
clean.window.online_filmix = true;
clean.scripts[0].onload();
assert.equal(clean.settingsPages.length, 1);
assert.equal(clean.settingsPages[0].id, 'fxapi');
clean.settingsPages[0].params.onBack();
assert.equal(clean.settingsPages[1].id, 'my_lampa_home');
clean.connect();
assert.equal(clean.scripts.length, 1, 'Already loaded FX was loaded twice');
assert.equal(clean.settingsPages[2].id, 'fxapi');
assert.equal(clean.pushes.length, 0, 'Account settings opened a movie');
assert.equal(clean.data.has('fxapi_token'), false, 'Vlas wrote account credentials');

// Disabling the movie button must not hide account/proxy settings.
disabled.connect();
disabled.window.online_filmix = true;
disabled.scripts[0].onload();
assert.equal(disabled.settingsPages[0].id, 'fxapi');
installed.connect();
assert.equal(installed.scripts.length, 0);
assert.equal(installed.settingsPages[0].id, 'fxapi');

const unavailable = setup();
unavailable.connect(); unavailable.scripts[0].onerror();
assert.equal(unavailable.settingsPages.length, 0);
assert.equal(unavailable.notices.length, 1);
unavailable.connect();
assert.equal(unavailable.scripts.length, 2, 'Failure did not allow retry');
unavailable.window.online_filmix = true;
unavailable.scripts[1].onload();
assert.equal(unavailable.settingsPages[0].id, 'fxapi');

const timeout = setup();
timeout.connect(); timeout.timeout();
assert.equal(timeout.settingsPages.length, 0);
assert.equal(timeout.notices.length, 1);
timeout.connect();
assert.equal(timeout.scripts.length, 2);
timeout.scripts[1].onerror();

const partial = setup({installed: true, partial: true});
partial.connect();
assert.equal(partial.settingsPages.length, 0, 'Unregistered FX opened a blank page');
assert.equal(partial.notices.length, 1);
const legacy = setup({noSettings: true});
legacy.connect();
assert.equal(legacy.scripts.length, 0);
assert.equal(legacy.notices.length, 1);
old.connect();
assert.equal(old.settingsPages.length, 0);
assert.equal(old.scripts.length, 0);

// The movie and settings entry share the same lazy loader.
const simultaneous = setup();
simultaneous.open().handler(); simultaneous.connect();
assert.equal(simultaneous.scripts.length, 1);
simultaneous.window.online_filmix = true;
simultaneous.scripts[0].onload();
assert.equal(simultaneous.settingsPages[0].id, 'fxapi');
assert.equal(simultaneous.pushes.length, 1);
console.log('Filmix integration: OK');
