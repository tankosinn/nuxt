import { resolve } from 'pathe'
import { consola } from 'consola'
import { expect, it, vi } from 'vitest'

import { scanComponents } from '../src/components/scan'
import { componentsFixtureDir } from './utils'
import type { ComponentsDir } from 'nuxt/schema'

const rFixture = (...p: string[]) => resolve(componentsFixtureDir, ...p)

vi.mock('@nuxt/kit', () => ({
  isIgnored: () => false,
  useLogger: () => consola.create({}).withTag('nuxt'),
}))

const dirs: ComponentsDir[] = [
  {
    path: rFixture('components/islands'),
    enabled: true,
    extensions: [
      'vue',
    ],
    pattern: '**/*.{vue,}',
    ignore: [
      '**/*.stories.{js,ts,jsx,tsx}',
      '**/*{M,.m,-m}ixin.{js,ts,jsx,tsx}',
      '**/*.d.ts',
    ],
    transpile: false,
    island: true,
  },
  {
    path: rFixture('components/global'),
    enabled: true,
    extensions: [
      'vue',
    ],
    pattern: '**/*.{vue,}',
    ignore: [
      '**/*.stories.{js,ts,jsx,tsx}',
      '**/*{M,.m,-m}ixin.{js,ts,jsx,tsx}',
      '**/*.d.ts',
    ],
    transpile: false,
    global: true,
  },
  {
    path: rFixture('components'),
    enabled: true,
    extensions: [
      'vue',
    ],
    pattern: '**/*.{vue,}',
    ignore: [
      '**/*.stories.{js,ts,jsx,tsx}',
      '**/*{M,.m,-m}ixin.{js,ts,jsx,tsx}',
      '**/*.d.ts',
    ],
    transpile: false,
  },
  {
    path: rFixture('components'),
    enabled: true,
    extensions: [
      'vue',
    ],
    pattern: '**/*.{vue,}',
    ignore: [
      '**/*.stories.{js,ts,jsx,tsx}',
      '**/*{M,.m,-m}ixin.{js,ts,jsx,tsx}',
      '**/*.d.ts',
    ],
    transpile: false,
  },
  {
    path: rFixture('components'),
    extensions: [
      'vue',
    ],
    prefix: 'nuxt',
    enabled: true,
    pattern: '**/*.{vue,}',
    ignore: [
      '**/*.stories.{js,ts,jsx,tsx}',
      '**/*{M,.m,-m}ixin.{js,ts,jsx,tsx}',
      '**/*.d.ts',
    ],
    transpile: false,
  },
]
const dirUnable = dirs.map((d) => { return { ...d, enabled: false } })
const expectedComponents = [
  {
    chunkName: 'components/isle-server',
    export: 'default',
    global: undefined,
    island: true,
    kebabName: 'isle',
    mode: 'server',
    pascalName: 'Isle',
    prefetch: false,
    preload: false,
    priority: 1,
    shortPath: 'components/islands/Isle.vue',
  },
  {
    chunkName: 'components/glob',
    export: 'default',
    global: true,
    island: undefined,
    kebabName: 'glob',
    mode: 'all',
    pascalName: 'Glob',
    prefetch: false,
    preload: false,
    priority: 1,
    shortPath: 'components/global/Glob.vue',
  },
  {
    mode: 'all',
    pascalName: 'HelloWorld',
    kebabName: 'hello-world',
    chunkName: 'components/hello-world',
    shortPath: 'components/HelloWorld.vue',
    export: 'default',
    global: undefined,
    island: undefined,
    prefetch: false,
    preload: false,
    priority: 1,
  },
  {
    mode: 'client',
    pascalName: 'Nuxt3',
    kebabName: 'nuxt3',
    chunkName: 'components/nuxt3-client',
    shortPath: 'components/Nuxt3.client.vue',
    export: 'default',
    global: undefined,
    island: undefined,
    prefetch: false,
    preload: false,
    priority: 1,
  },
  {
    mode: 'server',
    pascalName: 'Nuxt3',
    kebabName: 'nuxt3',
    chunkName: 'components/nuxt3-server',
    shortPath: 'components/Nuxt3.server.vue',
    export: 'default',
    global: undefined,
    island: undefined,
    prefetch: false,
    preload: false,
    priority: 1,
  },
  {
    chunkName: 'components/client-component-with-props',
    export: 'default',
    global: undefined,
    island: undefined,
    kebabName: 'client-component-with-props',
    mode: 'all',
    pascalName: 'ClientComponentWithProps',
    prefetch: false,
    preload: false,
    priority: 1,
    shortPath: 'components/client/ComponentWithProps.vue',
  },
  {
    chunkName: 'components/client-with-client-only-setup',
    export: 'default',
    global: undefined,
    island: undefined,
    kebabName: 'client-with-client-only-setup',
    mode: 'all',
    pascalName: 'ClientWithClientOnlySetup',
    prefetch: false,
    preload: false,
    priority: 1,
    shortPath: 'components/client/WithClientOnlySetup.vue',
  },
  {
    mode: 'server',
    pascalName: 'ParentFolder',
    kebabName: 'parent-folder',
    chunkName: 'components/parent-folder-server',
    shortPath: 'components/parent-folder/index.server.vue',
    export: 'default',
    global: undefined,
    island: undefined,
    prefetch: false,
    preload: false,
    priority: 1,
  },
  {
    chunkName: 'components/same-name-same',
    export: 'default',
    global: undefined,
    island: undefined,
    kebabName: 'same-name-same',
    mode: 'all',
    pascalName: 'SameNameSame',
    prefetch: false,
    preload: false,
    priority: 1,
    shortPath: 'components/same-name/same/Same.vue',
  },
  {
    chunkName: 'components/some-glob',
    export: 'default',
    global: true,
    island: undefined,
    kebabName: 'some-glob',
    mode: 'all',
    pascalName: 'SomeGlob',
    prefetch: false,
    preload: false,
    priority: 1,
    shortPath: 'components/some-glob.global.vue',
  },
  {
    chunkName: 'components/some-server',
    export: 'default',
    global: undefined,
    island: true,
    kebabName: 'some',
    mode: 'server',
    pascalName: 'Some',
    prefetch: false,
    preload: false,
    priority: 1,
    shortPath: 'components/some.island.vue',
  },
]

const srcDir = rFixture('.')

it('components:scanComponents', async () => {
  const scannedComponents = await scanComponents(dirs, srcDir)
  for (const c of scannedComponents) {
    // @ts-expect-error filePath is not optional but we don't want it to be in the snapshot
    delete c.filePath
    // @ts-expect-error _scanned is added internally but we don't want it to be in the snapshot
    delete c._scanned
  }
  expect(scannedComponents).deep.eq(expectedComponents)
})

it('components:scanComponents:unable', async () => {
  const scannedComponents = await scanComponents(dirUnable, srcDir)
  expect(scannedComponents).deep.eq([])
})
