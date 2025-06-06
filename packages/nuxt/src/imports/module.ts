import { existsSync } from 'node:fs'
import { addBuildPlugin, addTemplate, addTypeTemplate, createIsIgnored, defineNuxtModule, directoryToURL, resolveAlias, tryResolveModule, updateTemplates, useNuxt } from '@nuxt/kit'
import { isAbsolute, join, normalize, relative, resolve } from 'pathe'
import type { Import, Unimport } from 'unimport'
import { createUnimport, scanDirExports, toExports } from 'unimport'
import escapeRE from 'escape-string-regexp'

import { lookupNodeModuleSubpath, parseNodeModulePath } from 'mlly'
import { isDirectory, logger } from '../utils'
import { TransformPlugin } from './transform'
import { appCompatPresets, defaultPresets } from './presets'
import type { ImportPresetWithDeprecation, ImportsOptions, ResolvedNuxtTemplate } from 'nuxt/schema'

export default defineNuxtModule<Partial<ImportsOptions>>({
  meta: {
    name: 'nuxt:imports',
    configKey: 'imports',
  },
  defaults: nuxt => ({
    autoImport: true,
    scan: true,
    presets: defaultPresets,
    global: false,
    imports: [],
    dirs: [],
    transform: {
      include: [
        new RegExp('^' + escapeRE(nuxt.options.buildDir)),
      ],
      exclude: undefined,
    },
    virtualImports: ['#imports'],
    polyfills: true,
  }),
  async setup (options, nuxt) {
    // TODO: fix sharing of defaults between invocations of modules
    const presets = JSON.parse(JSON.stringify(options.presets)) as ImportPresetWithDeprecation[]

    if (options.polyfills) {
      presets.push(...appCompatPresets)
    }

    // Allow modules extending sources
    await nuxt.callHook('imports:sources', presets)

    // Filter disabled sources
    // options.sources = options.sources.filter(source => source.disabled !== true)

    const { addons: inlineAddons, ...rest } = options

    const [addons, addonsOptions] = Array.isArray(inlineAddons) ? [inlineAddons] : [[], inlineAddons]

    // Create a context to share state between module internals
    const ctx = createUnimport({
      injectAtEnd: true,
      ...rest,
      addons: {
        addons,
        vueTemplate: options.autoImport,
        vueDirectives: options.autoImport === false ? undefined : true,
        ...addonsOptions,
      },
      presets,
    })

    await nuxt.callHook('imports:context', ctx)

    // composables/ dirs from all layers
    let composablesDirs: string[] = []
    if (options.scan) {
      for (const layer of nuxt.options._layers) {
        // Layer disabled scanning for itself
        if (layer.config?.imports?.scan === false) {
          continue
        }

        composablesDirs.push(
          resolve(layer.config.srcDir, 'composables'),
          resolve(layer.config.srcDir, 'utils'),
          resolve(layer.config.rootDir, layer.config.dir?.shared ?? 'shared', 'utils'),
          resolve(layer.config.rootDir, layer.config.dir?.shared ?? 'shared', 'types'),
        )

        for (const dir of (layer.config.imports?.dirs ?? [])) {
          if (!dir) {
            continue
          }
          composablesDirs.push(resolve(layer.config.srcDir, dir))
        }
      }

      await nuxt.callHook('imports:dirs', composablesDirs)
      composablesDirs = composablesDirs.map(dir => normalize(dir))

      // Restart nuxt when composable directories are added/removed
      nuxt.hook('builder:watch', (event, relativePath) => {
        if (!['addDir', 'unlinkDir'].includes(event)) { return }

        const path = resolve(nuxt.options.srcDir, relativePath)
        if (composablesDirs.includes(path)) {
          logger.info(`Directory \`${relativePath}/\` ${event === 'addDir' ? 'created' : 'removed'}`)
          return nuxt.callHook('restart')
        }
      })
    }

    // Support for importing from '#imports'
    addTemplate({
      filename: 'imports.mjs',
      getContents: async () => toExports(await ctx.getImports()) + '\nif (import.meta.dev) { console.warn("[nuxt] `#imports` should be transformed with real imports. There seems to be something wrong with the imports plugin.") }',
    })
    nuxt.options.alias['#imports'] = join(nuxt.options.buildDir, 'imports')

    // Transform to inject imports in production mode
    addBuildPlugin(TransformPlugin({ ctx, options, sourcemap: !!nuxt.options.sourcemap.server || !!nuxt.options.sourcemap.client }))

    const priorities = nuxt.options._layers.map((layer, i) => [layer.config.srcDir, -i] as const).sort(([a], [b]) => b.length - a.length)

    const IMPORTS_TEMPLATE_RE = /\/imports\.(?:d\.ts|mjs)$/
    function isImportsTemplate (template: ResolvedNuxtTemplate) {
      return IMPORTS_TEMPLATE_RE.test(template.filename)
    }

    const isIgnored = createIsIgnored(nuxt)
    const defaultImportSources = new Set(defaultPresets.flatMap(i => i.from))
    const defaultImports = new Set(presets.flatMap(p => defaultImportSources.has(p.from) ? p.imports : []))
    const regenerateImports = async () => {
      await ctx.modifyDynamicImports(async (imports) => {
        // Clear old imports
        imports.length = 0

        // Scan for `composables/` and `utils/` directories
        if (options.scan) {
          const scannedImports = await scanDirExports(composablesDirs, {
            fileFilter: file => !isIgnored(file),
          })
          for (const i of scannedImports) {
            i.priority ||= priorities.find(([dir]) => i.from.startsWith(dir))?.[1]
          }
          imports.push(...scannedImports)
        }

        // Modules extending
        await nuxt.callHook('imports:extend', imports)
        for (const i of imports) {
          if (!defaultImportSources.has(i.from)) {
            const value = i.as || i.name
            if (defaultImports.has(value) && (!i.priority || i.priority >= 0 /* default priority */)) {
              const relativePath = isAbsolute(i.from) ? `~/${relative(nuxt.options.srcDir, i.from)}` : i.from
              logger.error(`\`${value}\` is an auto-imported function that is in use by Nuxt. Overriding it will likely cause issues. Please consider renaming \`${value}\` in \`${relativePath}\`.`)
            }
          }
        }

        return imports
      })

      await updateTemplates({
        filter: isImportsTemplate,
      })
    }

    await regenerateImports()

    // Generate types
    addDeclarationTemplates(ctx, options)

    // Watch composables/ directory
    nuxt.hook('builder:watch', async (_, relativePath) => {
      const path = resolve(nuxt.options.srcDir, relativePath)
      if (options.scan && composablesDirs.some(dir => dir === path || path.startsWith(dir + '/'))) {
        await regenerateImports()
      }
    })

    // Watch for template generation
    nuxt.hook('app:templatesGenerated', async (_app, templates) => {
      // Only regenerate when non-imports templates are updated
      if (templates.some(t => !isImportsTemplate(t))) {
        await regenerateImports()
      }
    })
  },
})

function addDeclarationTemplates (ctx: Unimport, options: Partial<ImportsOptions>) {
  const nuxt = useNuxt()

  const resolvedImportPathMap = new Map<string, string>()
  const r = ({ from }: Import) => resolvedImportPathMap.get(from)

  const SUPPORTED_EXTENSION_RE = new RegExp(`\\.(${nuxt.options.extensions.map(i => i.replace('.', '')).join('|')})$`)

  const importPaths = nuxt.options.modulesDir.map(dir => directoryToURL(dir))

  async function cacheImportPaths (imports: Import[]) {
    const importSource = Array.from(new Set(imports.map(i => i.from)))
    // skip relative import paths for node_modules that are explicitly installed
    await Promise.all(importSource.map(async (from) => {
      if (resolvedImportPathMap.has(from) || nuxt._dependencies?.has(from)) {
        return
      }
      let path = resolveAlias(from)
      if (!isAbsolute(path)) {
        path = await tryResolveModule(from, importPaths).then(async (r) => {
          if (!r) { return r }

          const { dir, name } = parseNodeModulePath(r)
          if (name && nuxt._dependencies?.has(name)) { return from }

          if (!dir || !name) { return r }
          const subpath = await lookupNodeModuleSubpath(r)
          return join(dir, name, subpath || '')
        }) ?? path
      }

      if (existsSync(path) && !(await isDirectory(path))) {
        path = path.replace(SUPPORTED_EXTENSION_RE, '')
      }

      if (isAbsolute(path)) {
        path = relative(join(nuxt.options.buildDir, 'types'), path)
      }

      resolvedImportPathMap.set(from, path)
    }))
  }

  addTypeTemplate({
    filename: 'imports.d.ts',
    getContents: async ({ nuxt }) => toExports(await ctx.getImports(), nuxt.options.buildDir, true),
  })

  addTypeTemplate({
    filename: 'types/imports.d.ts',
    getContents: async () => {
      const imports = await ctx.getImports()
      await cacheImportPaths(imports)
      return '// Generated by auto imports\n' + (
        options.autoImport
          ? await ctx.generateTypeDeclarations({ resolvePath: r })
          : '// Implicit auto importing is disabled, you can use explicitly import from `#imports` instead.'
      )
    },
  })
}
