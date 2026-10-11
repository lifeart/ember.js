// gxt NATIVE layer — alias target for
// `@ember/-internals/glimmer/lib/components/textarea`. `<Textarea>` /
// `{{textarea}}` are out of scope for P1 (design §2.5: documented drop; a native
// `.gts` replacement may land in P4).
import { documentedDrop } from '../not-implemented';

export default class Textarea {
  static toString(): string {
    return 'Textarea';
  }
  constructor() {
    documentedDrop('`<Textarea>`', 'Use a plain <textarea> with {{on "input"}} instead.');
  }
}
