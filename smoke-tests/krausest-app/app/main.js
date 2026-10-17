// Boot entry (same shape as smoke-tests/modern-app). No `dt7948` global:
// decorators import decorator-transforms' runtime in every variant (babel for
// .js; for .gjs on gxt, the gxt compiler imports it under
// WITH_EMBER_INTEGRATION).
import './boot-mark.js';
import App from './app.js';
import config from './config/environment.js';

App.create(config.APP);
