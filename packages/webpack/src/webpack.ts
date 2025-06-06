import pify from 'pify'
import { createError, defineEventHandler, fromNodeMiddleware, getRequestHeader, handleCors, setHeader } from 'h3'
import type { H3CorsOptions } from 'h3'
import type { IncomingMessage, MultiWatching, ServerResponse } from 'webpack-dev-middleware'
import webpackDevMiddleware from 'webpack-dev-middleware'
import webpackHotMiddleware from 'webpack-hot-middleware'
import type { Compiler, Stats, Watching } from 'webpack'
import { defu } from 'defu'
import type { NuxtBuilder } from '@nuxt/schema'
import { joinURL } from 'ufo'
import { logger, useNitro, useNuxt } from '@nuxt/kit'
import type { InputPluginOption } from 'rollup'

import { DynamicBasePlugin } from './plugins/dynamic-base'
import { ChunkErrorPlugin } from './plugins/chunk'
import { createMFS } from './utils/mfs'
import { client, server } from './configs'
import { applyPresets, createWebpackConfigContext } from './utils/config'

import { builder, webpack } from '#builder'

// TODO: Support plugins
// const plugins: string[] = []

export const bundle: NuxtBuilder['bundle'] = async (nuxt) => {
  const webpackConfigs = await Promise.all([client, ...nuxt.options.ssr ? [server] : []].map(async (preset) => {
    const ctx = createWebpackConfigContext(nuxt)
    ctx.userConfig = defu(nuxt.options.webpack[`$${preset.name as 'client' | 'server'}`], ctx.userConfig)
    await applyPresets(ctx, preset)
    return ctx.config
  }))

  /** Remove Nitro rollup plugin for handling dynamic imports from webpack chunks */
  if (!nuxt.options.dev) {
    const nitro = useNitro()
    nitro.hooks.hook('rollup:before', (_nitro, config) => {
      const plugins = config.plugins as InputPluginOption[]

      const existingPlugin = plugins.findIndex(i => i && 'name' in i && i.name === 'dynamic-require')
      if (existingPlugin >= 0) {
        plugins.splice(existingPlugin, 1)
      }
    })
  }

  await nuxt.callHook(`${builder}:config`, webpackConfigs)

  // Initialize shared MFS for dev
  const mfs = nuxt.options.dev ? createMFS() : null

  for (const config of webpackConfigs) {
    config.plugins!.push(DynamicBasePlugin.webpack({
      sourcemap: !!nuxt.options.sourcemap[config.name as 'client' | 'server'],
    }))
    // Emit chunk errors if the user has opted in to `experimental.emitRouteChunkError`
    if (config.name === 'client' && nuxt.options.experimental.emitRouteChunkError && nuxt.options.builder !== '@nuxt/rspack-builder') {
      config.plugins!.push(new ChunkErrorPlugin())
    }
  }

  await nuxt.callHook(`${builder}:configResolved`, webpackConfigs)

  // Configure compilers
  const compilers = webpackConfigs.map((config) => {
    // Create compiler
    const compiler = webpack(config)

    // In dev, write files in memory FS
    if (nuxt.options.dev) {
      compiler.outputFileSystem = mfs! as unknown as Compiler['outputFileSystem']
    }

    return compiler
  })

  nuxt.hook('close', async () => {
    for (const compiler of compilers) {
      await new Promise(resolve => compiler.close(resolve))
    }
  })

  // Start Builds
  if (nuxt.options.dev) {
    await Promise.all(compilers.map(c => compile(c)))
    return
  }

  for (const c of compilers) {
    await compile(c)
  }
}

async function createDevMiddleware (compiler: Compiler) {
  const nuxt = useNuxt()

  logger.debug('Creating webpack middleware...')

  // Create webpack dev middleware
  const devMiddleware = webpackDevMiddleware(compiler, {
    publicPath: joinURL(nuxt.options.app.baseURL, nuxt.options.app.buildAssetsDir),
    outputFileSystem: compiler.outputFileSystem as any,
    stats: 'none',
    ...nuxt.options.webpack.devMiddleware,
  })

  // @ts-expect-error need better types for `pify`
  nuxt.hook('close', () => pify(devMiddleware.close.bind(devMiddleware))())

  const { client: _client, ...hotMiddlewareOptions } = nuxt.options.webpack.hotMiddleware || {}
  const hotMiddleware = webpackHotMiddleware(compiler, {
    log: false,
    heartbeat: 10000,
    path: joinURL(nuxt.options.app.baseURL, '__webpack_hmr', compiler.options.name!),
    ...hotMiddlewareOptions,
  })

  // Register devMiddleware on server
  const devHandler = wdmToH3Handler(devMiddleware, nuxt.options.devServer.cors)
  const hotHandler = fromNodeMiddleware(hotMiddleware)
  await nuxt.callHook('server:devHandler', defineEventHandler(async (event) => {
    const body = await devHandler(event)
    if (body !== undefined) {
      return body
    }
    await hotHandler(event)
  }))

  return devMiddleware
}

// TODO: implement upstream in `webpack-dev-middleware`
function wdmToH3Handler (devMiddleware: webpackDevMiddleware.API<IncomingMessage, ServerResponse>, corsOptions: H3CorsOptions) {
  return defineEventHandler(async (event) => {
    const isPreflight = handleCors(event, corsOptions)
    if (isPreflight) {
      return null
    }

    // disallow cross-site requests in no-cors mode
    if (getRequestHeader(event, 'sec-fetch-mode') === 'no-cors' && getRequestHeader(event, 'sec-fetch-site') === 'cross-site') {
      throw createError({ statusCode: 403 })
    }

    setHeader(event, 'Vary', 'Origin')

    event.context.webpack = {
      ...event.context.webpack,
      devMiddleware: devMiddleware.context,
    }
    const { req, res } = event.node
    const body = await new Promise((resolve, reject) => {
      // @ts-expect-error handle injected methods
      res.stream = (stream) => {
        resolve(stream)
      }
      // @ts-expect-error handle injected methods
      res.send = (data) => {
        resolve(data)
      }
      // @ts-expect-error handle injected methods
      res.finish = (data) => {
        resolve(data)
      }
      devMiddleware(req, res, (err) => {
        if (err) {
          reject(err)
        } else {
          resolve(undefined)
        }
      })
    })
    return body
  })
}

async function compile (compiler: Compiler) {
  const nuxt = useNuxt()

  await nuxt.callHook(`${builder}:compile`, { name: compiler.options.name!, compiler })

  // Load renderer resources after build
  compiler.hooks.done.tap('load-resources', async (stats) => {
    await nuxt.callHook(`${builder}:compiled`, { name: compiler.options.name!, compiler, stats })
  })

  // --- Dev Build ---
  if (nuxt.options.dev) {
    const compilersWatching: Array<Watching | MultiWatching> = []

    nuxt.hook('close', async () => {
      await Promise.all(compilersWatching.map(watching => pify(watching.close.bind(watching))()))
    })

    // Client build
    if (compiler.options.name === 'client') {
      return new Promise((resolve, reject) => {
        compiler.hooks.done.tap('nuxt-dev', () => { resolve(null) })
        compiler.hooks.failed.tap('nuxt-errorlog', (err) => { reject(err) })
        // Start watch
        createDevMiddleware(compiler).then((devMiddleware) => {
          if (devMiddleware.context.watching) {
            compilersWatching.push(devMiddleware.context.watching)
          }
        })
      })
    }

    // Server, build and watch for changes
    return new Promise((resolve, reject) => {
      const watching = compiler.watch(nuxt.options.watchers.webpack, (err) => {
        if (err) { return reject(err) }
        resolve(null)
      })

      compilersWatching.push(watching)
    })
  }

  // --- Production Build ---
  const stats = await new Promise<Stats>((resolve, reject) => compiler.run((err, stats) => err ? reject(err) : resolve(stats!)))

  if (stats.hasErrors()) {
    const error = new Error('Nuxt build error')
    error.stack = stats.toString('errors-only')
    throw error
  }
}
