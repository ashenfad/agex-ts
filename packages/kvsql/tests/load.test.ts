import { it } from 'vitest'
import { checkLoads } from './load'

it('loads the pinned SQLite build in Node, with the session extension', checkLoads)
