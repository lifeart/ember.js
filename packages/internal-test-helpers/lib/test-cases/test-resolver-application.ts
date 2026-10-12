import AbstractApplicationTestCase from './abstract-application';
import type Resolver from '../test-resolver';
import { ModuleBasedResolver } from '../test-resolver';
import type { InternalFactory } from '@ember/-internals/owner';

export default abstract class TestResolverApplicationTestCase extends AbstractApplicationTestCase {
  abstract resolver?: Resolver;

  get applicationOptions() {
    return Object.assign(super.applicationOptions, {
      Resolver: ModuleBasedResolver,
    });
  }

  add(specifier: string, factory: InternalFactory<object> | object) {
    this.resolver!.add(specifier, factory);
  }

  asTemplate(ComponentKlass: any) {
    return (_owner: any) => {
      // template lookup
      return () => {
        // template init
        return function () {
          return {
            template: ComponentKlass,
          };
        };
      };
    };
  }

  addTemplate(templateName: string, templateString: any) {
    if (typeof templateString === 'function') {
      this.resolver!.add(`template:${templateName}`, this.asTemplate(templateString));
    } else {
      this.resolver!.add(
        `template:${templateName}`,
        this.compile(templateString, {
          moduleName: `my-app/templates/${templateName.replace(/\./g, '/')}.hbs`,
        })
      );
    }
  }
}
