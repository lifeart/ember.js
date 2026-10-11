// First module main.js imports: its body runs before any ember module body
// (rollup keeps evaluation order inside the chunk), so `js-start` splits boot
// into "load + parse/compile" (navigation → js-start) and "evaluate + boot +
// first render" (js-start → first-render, recorded by the driver).
performance.mark('js-start');
