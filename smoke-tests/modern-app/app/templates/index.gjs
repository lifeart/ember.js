import Counter from '../components/counter.gjs';

// gxt seam (see scripts/bundle-modern-app.mjs header): keep template-only imports
// referenced in JS so the host babel.config's TypeScript import elision
// (inherited by @lifeart/gxt's compiler) cannot drop them. Dead code — terser
// removes it, so it costs 0 shipped bytes in every variant.
void [Counter];

<template>
  <h1 data-test-title>Modern app</h1>
  <Counter @label="main" />
</template>
