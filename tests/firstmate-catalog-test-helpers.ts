import { strict as assert } from 'node:assert'
import type { FirstMateProjectCatalog } from '../src/shared/firstmate'

export function firstMateCatalogFromRequest(prompt: string): FirstMateProjectCatalog {
  const json = /<ade-project-catalog>\n([^\n]+)\n<\/ade-project-catalog>/.exec(prompt)?.[1]
  assert.ok(json, 'the request should contain one machine-readable project catalog')
  return JSON.parse(json) as FirstMateProjectCatalog
}
