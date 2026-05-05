import { Memory } from '../src/backends/memory'
import { runConformance } from './kv-conformance'

runConformance('Memory', () => new Memory())
