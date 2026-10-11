import formatPrice from '../helpers/format-price.js';

// gxt seam (see scripts/bundle-modern-app.mjs header): keep template-only imports
// referenced in JS so the host babel.config's TypeScript import elision
// (inherited by @lifeart/gxt's compiler) cannot drop them. Dead code — terser
// removes it, so it costs 0 shipped bytes in every variant.
void [formatPrice];

<template>
  <ul data-test-items>
    {{#each @items as |item index|}}
      {{#let (formatPrice item.price) as |price|}}
        <li>{{index}}: {{item.name}} {{price}}</li>
      {{/let}}
    {{else}}
      <li>empty</li>
    {{/each}}
  </ul>
  {{#if @showCount}}
    <p data-test-item-count>{{@items.length}} items</p>
  {{/if}}
</template>
