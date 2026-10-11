import { LinkTo } from '@ember/routing';

// gxt seam (see scripts/bundle-modern-app.mjs header): keep template-only imports
// referenced in JS so the host babel.config's TypeScript import elision
// (inherited by @lifeart/gxt's compiler) cannot drop them. Dead code — terser
// removes it, so it costs 0 shipped bytes in every variant.
void [LinkTo];

<template>
  <nav>
    <LinkTo @route="index" data-test-link-index>Home</LinkTo>
    <LinkTo @route="about" data-test-link-about>About</LinkTo>
  </nav>
  <main>{{outlet}}</main>
</template>
