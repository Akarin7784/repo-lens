import { helper } from '@core/helper';
import _ from 'lodash';
export class App { run() { return helper(_.identity(1)); } }
export function createApp(a: App, s: string) { return [a, s]; }
export default App;
