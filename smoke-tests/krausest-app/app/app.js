import Application from 'ember-strict-application-resolver';

export default class App extends Application {
  modules = {
    ...import.meta.glob('./router.js', { eager: true }),
    ...import.meta.glob('./templates/*.gjs', { eager: true }),
  };
}
