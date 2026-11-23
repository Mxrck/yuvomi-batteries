// `node --import ./test/module/register.mjs --test …` maps the absolute browser imports the module
// uses (/i18n.js, /api.js, /utils/html.js) to small stubs, so the view functions, which return
// HTML strings, run in Node without a browser.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
