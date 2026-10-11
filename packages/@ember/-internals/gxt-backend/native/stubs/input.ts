// gxt NATIVE layer — alias target for
// `@ember/-internals/glimmer/lib/components/input`. `<Input>` / `{{input}}` are
// out of scope for P1 (design §2.5: documented drop; a ~1 KB native `.gts`
// replacement may land in P4). Registered as `component:input` so a resolver
// lookup fails with this message instead of "component not found".
import { documentedDrop } from '../not-implemented';

export default class Input {
  static toString(): string {
    return 'Input';
  }
  constructor() {
    documentedDrop('`<Input>`', 'Use a plain <input> with {{on "input"}} instead.');
  }
}
