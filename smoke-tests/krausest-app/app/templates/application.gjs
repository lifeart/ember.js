import { ComponentBench, IfBench, InlineBench } from '../components/bench.gjs';

const ROWS = new URLSearchParams(location.search).get('rows');
const ROW_COMPONENT = ROWS === 'component';
const IF_ROWS = ROWS === 'if';

<template>
  {{#if ROW_COMPONENT}}
    <ComponentBench />
  {{else if IF_ROWS}}
    <IfBench />
  {{else}}
    <InlineBench />
  {{/if}}
</template>
