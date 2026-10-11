import Component from '@glimmer/component';
import { on } from '@ember/modifier';

// Row-component mode (`?rows=component`): one Glimmer component per row, so the
// per-invocation component-manager cost and component args are on the path.
export default class Row extends Component {
  select = () => this.args.onSelect(this.args.row);
  remove = () => this.args.onRemove(this.args.row);

  <template>
    <tr class={{if @selected "danger"}}>
      <td class="col-md-1">{{@row.id}}</td>
      <td class="col-md-4"><a data-test-select {{on "click" this.select}}>{{@row.label}}</a></td>
      <td class="col-md-1"><a data-test-remove {{on "click" this.remove}}><span class="glyphicon glyphicon-remove" aria-hidden="true"></span></a></td>
      <td class="col-md-6"></td>
    </tr>
  </template>
}
