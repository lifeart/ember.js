import { ComponentBench, InlineBench } from '../components/bench.gjs';

const ROW_COMPONENT = new URLSearchParams(location.search).get('rows') === 'component';

<template>
  {{#if ROW_COMPONENT}}
    <ComponentBench />
  {{else}}
    <InlineBench />
  {{/if}}
</template>
