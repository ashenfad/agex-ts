/**
 * kvsql's default worker: serves databases kept by `openDefault` (the
 * file in OPFS, the log on IndexedDB). Start it as a module worker and
 * connect to it with `connect` from `@agex-ts/kvsql/client`.
 */

import { openDefault } from './default'
import { serve } from './host'

serve(openDefault)
