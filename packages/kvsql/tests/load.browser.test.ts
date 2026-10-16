import { it } from 'vitest'
import { checkLoads } from './load'

it('loads the pinned SQLite build in the browser, with the session extension', checkLoads)
