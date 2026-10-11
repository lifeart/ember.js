// Boot entry (same shape as smoke-tests/modern-app). `decorator-transforms/globals`
// installs the `dt7948` global the gxt compiler's decorator pass emits for `.gjs`
// class fields; imported in every variant so the app source is identical.
import './boot-mark.js';
import 'decorator-transforms/globals';
import App from './app.js';
import config from './config/environment.js';

App.create(config.APP);
