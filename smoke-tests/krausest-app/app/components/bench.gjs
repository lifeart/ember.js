import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';
import { fn } from '@ember/helper';
import { buildData, buildFlagData } from '../data.js';
import Row from './row.gjs';

// krausest js-framework-benchmark (keyed) on idiomatic modern Ember: a Glimmer
// component, `@tracked` state replaced immutably, `@tracked` row labels,
// `{{#each key="id"}}` directly inside `<tbody>` and `{{on "click"}}` rows.
class BenchState extends Component {
  @tracked rows = [];
  @tracked selected = undefined;

  run = () => {
    this.rows = buildData(1000);
    this.selected = undefined;
  };

  runLots = () => {
    this.rows = buildData(10000);
    this.selected = undefined;
  };

  add = () => {
    this.rows = this.rows.concat(buildData(1000));
  };

  update = () => {
    const rows = this.rows;
    for (let i = 0; i < rows.length; i += 10) rows[i].label += ' !!!';
  };

  clear = () => {
    this.rows = [];
    this.selected = undefined;
  };

  swapRows = () => {
    const rows = this.rows;
    if (rows.length > 998) {
      const next = rows.slice();
      const tmp = next[1];
      next[1] = next[998];
      next[998] = tmp;
      this.rows = next;
    }
  };

  remove = (row) => {
    const rows = this.rows;
    const index = rows.indexOf(row);
    this.rows = rows.slice(0, index).concat(rows.slice(index + 1));
  };

  select = (row) => {
    this.selected = row.id;
  };

  isSelected = (id) => this.selected === id;
}

const Jumbotron = <template>
  <div class="jumbotron">
    <div class="row">
      <div class="col-md-6"><h1>Ember (keyed)</h1></div>
      <div class="col-md-6">
        <div class="row">
          <div class="col-sm-6 smallpad"><button type="button" id="run" class="btn btn-primary btn-block" {{on "click" @state.run}}>Create 1,000 rows</button></div>
          <div class="col-sm-6 smallpad"><button type="button" id="runlots" class="btn btn-primary btn-block" {{on "click" @state.runLots}}>Create 10,000 rows</button></div>
          <div class="col-sm-6 smallpad"><button type="button" id="add" class="btn btn-primary btn-block" {{on "click" @state.add}}>Append 1,000 rows</button></div>
          <div class="col-sm-6 smallpad"><button type="button" id="update" class="btn btn-primary btn-block" {{on "click" @state.update}}>Update every 10th row</button></div>
          <div class="col-sm-6 smallpad"><button type="button" id="clear" class="btn btn-primary btn-block" {{on "click" @state.clear}}>Clear</button></div>
          <div class="col-sm-6 smallpad"><button type="button" id="swaprows" class="btn btn-primary btn-block" {{on "click" @state.swapRows}}>Swap Rows</button></div>
        </div>
      </div>
    </div>
  </div>
</template>;

// Rows as inline markup (the default).
export class InlineBench extends BenchState {
  <template>
    <div id="main">
      <div class="container">
        <Jumbotron @state={{this}} />
        <table class="table table-hover table-striped test-data">
          <tbody>
            {{#each this.rows key="id" as |row|}}
              <tr class={{if (this.isSelected row.id) "danger"}}>
                <td class="col-md-1">{{row.id}}</td>
                <td class="col-md-4"><a data-test-select {{on "click" (fn this.select row)}}>{{row.label}}</a></td>
                <td class="col-md-1"><a data-test-remove {{on "click" (fn this.remove row)}}><span class="glyphicon glyphicon-remove" aria-hidden="true"></span></a></td>
                <td class="col-md-6"></td>
              </tr>
            {{/each}}
          </tbody>
        </table>
        <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true"></span>
      </div>
    </div>
  </template>
}

// `?rows=component`: one Glimmer component per row, so the per-invocation
// component-manager cost and component arguments are on the path.
export class ComponentBench extends BenchState {
  <template>
    <div id="main">
      <div class="container">
        <Jumbotron @state={{this}} />
        <table class="table table-hover table-striped test-data">
          <tbody>
            {{#each this.rows key="id" as |row|}}
              <Row @row={{row}} @selected={{this.isSelected row.id}} @onSelect={{this.select}} @onRemove={{this.remove}} />
            {{/each}}
          </tbody>
        </table>
        <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true"></span>
      </div>
    </div>
  </template>
}

// `?rows=if` (the `{{#if}}` micro-benchmark): every row's label cell and remove
// cell are `{{#if}}` blocks — one global condition (`showLabels`, toggled for
// all 1,000 rows at once) and one per row (`row.flag`, every 10th row / one
// row) — so branch swaps, and rows whose cells swap, are on the path.
export class IfBench extends BenchState {
  @tracked showLabels = true;

  run = () => {
    this.rows = buildFlagData(1000);
    this.selected = undefined;
    this.showLabels = true;
  };

  runLots = () => {
    this.rows = buildFlagData(10000);
    this.selected = undefined;
    this.showLabels = true;
  };

  add = () => {
    this.rows = this.rows.concat(buildFlagData(1000));
  };

  toggleLabels = () => {
    this.showLabels = !this.showLabels;
  };

  toggle10th = () => {
    const rows = this.rows;
    for (let i = 0; i < rows.length; i += 10) rows[i].flag = !rows[i].flag;
  };

  toggleOne = () => {
    const row = this.rows[1];
    if (row !== undefined) row.flag = !row.flag;
  };

  <template>
    <div id="main">
      <div class="container">
        <Jumbotron @state={{this}} />
        <div class="row">
          <div class="col-sm-4 smallpad"><button type="button" id="togglelabels" class="btn btn-primary btn-block" {{on "click" this.toggleLabels}}>Toggle labels</button></div>
          <div class="col-sm-4 smallpad"><button type="button" id="toggle10th" class="btn btn-primary btn-block" {{on "click" this.toggle10th}}>Toggle every 10th row</button></div>
          <div class="col-sm-4 smallpad"><button type="button" id="toggleone" class="btn btn-primary btn-block" {{on "click" this.toggleOne}}>Toggle row 2</button></div>
        </div>
        <table class="table table-hover table-striped test-data">
          <tbody>
            {{#each this.rows key="id" as |row|}}
              <tr class={{if (this.isSelected row.id) "danger"}}>
                <td class="col-md-1">{{row.id}}</td>
                <td class="col-md-4">{{#if this.showLabels}}<a data-test-select {{on "click" (fn this.select row)}}>{{row.label}}</a>{{/if}}</td>
                <td class="col-md-1">{{#if row.flag}}<a data-test-remove {{on "click" (fn this.remove row)}}><span class="glyphicon glyphicon-remove" aria-hidden="true"></span></a>{{else}}<i>off</i>{{/if}}</td>
                <td class="col-md-6"></td>
              </tr>
            {{/each}}
          </tbody>
        </table>
        <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true"></span>
      </div>
    </div>
  </template>
}
