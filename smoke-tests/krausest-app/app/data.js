// krausest js-framework-benchmark data, with a SEEDED generator so both ember
// flavors render byte-identical labels (the driver asserts exact DOM content).
import { tracked } from '@glimmer/tracking';

const A = ['pretty', 'large', 'big', 'small', 'tall', 'short', 'long', 'handsome', 'plain', 'quaint', 'clean', 'elegant', 'easy', 'angry', 'crazy', 'helpful', 'mushy', 'odd', 'unsightly', 'adorable', 'important', 'inexpensive', 'cheap', 'expensive', 'fancy'];
const C = ['red', 'yellow', 'blue', 'green', 'pink', 'brown', 'purple', 'brown', 'white', 'black', 'orange'];
const N = ['table', 'chair', 'house', 'bbq', 'desk', 'car', 'pony', 'cookie', 'sandwich', 'burger', 'pizza', 'mouse', 'keyboard'];

// mulberry32
let seed = 0x2f6b9d3;
function random(max) {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) % 1000) % max;
}

export class Row {
  @tracked label;
  constructor(id, label) {
    this.id = id;
    this.label = label;
  }
}

// `?rows=if` mode: a row with a tracked flag its `{{#if row.flag}}` cell reads.
export class FlagRow extends Row {
  @tracked flag = true;
}

let nextId = 1;

export function buildData(count) {
  const data = new Array(count);
  for (let i = 0; i < count; i++) {
    data[i] = new Row(nextId++, `${A[random(A.length)]} ${C[random(C.length)]} ${N[random(N.length)]}`);
  }
  return data;
}

export function buildFlagData(count) {
  const data = new Array(count);
  for (let i = 0; i < count; i++) {
    data[i] = new FlagRow(nextId++, `${A[random(A.length)]} ${C[random(C.length)]} ${N[random(N.length)]}`);
  }
  return data;
}
