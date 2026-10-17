/**
 * A worker with storage of its own, as an app that brings its own
 * kvgit repository writes one: every database's log in one shared
 * repository (on IndexedDB), each file in its own OPFS directory.
 */

import { Repo } from '@agex-ts/kvgit'
import { IndexedDB } from '@agex-ts/kvgit/backends/idb'
import { OpfsDirectory, serve } from '../src/index'

const repo = IndexedDB.open({ dbName: 'kvsql-tests-shared-repo' }).then((store) => Repo.open(store))

serve(async (config) => ({
  dir: await OpfsDirectory.at('kvsql-tests', config.id),
  repo: await repo,
}))
