/**
 * Host half of the reading bundle.
 *
 * Responsibilities:
 *  - own the durable library under `$DSH_HOME/reading` (or `config.libraryDir`);
 *  - serve the browser UI over Connection's authenticated exact Fetch routes;
 *  - stream in-reader Q&A through the composition's own LLM service;
 *  - register the model-facing reading tools.
 *
 * The browser half (client.js) only renders and calls these entry points, so the
 * library stays readable by the agent even when no page is open.
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Library } from './host/store.js'
import { createAskService } from './host/ask.js'
import { attachRoutes } from './host/routes.js'
import { createTools } from './host/tools.js'

export const name = 'reading'
export const inject = ['connection']

/** Resolve the library root: absolute, `~`-relative, or relative to `$DSH_HOME`. */
export function resolveLibraryDir(configured) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const value = typeof configured === 'string' ? configured.trim() : ''
  if (!value) return join(home, 'reading')
  const expanded = value.startsWith('~') ? join(homedir(), value.slice(1)) : value
  return isAbsolute(expanded) ? expanded : join(home, expanded)
}

export function apply(ctx, config) {
  const options = config && typeof config === 'object' ? config : {}
  const library = new Library(resolveLibraryDir(options.libraryDir))
  const ask = createAskService(ctx, library, options)

  // Every browser entry point - unary RPC included - is an exact Fetch route
  // under Connection's authenticated `/api` prefix. Do NOT register a dedicated
  // RPC channel through `ctx.connection.rpc.handle()`: from a bundle that call
  // fails inside `owner.webServer` with "cannot get property \"webServer\"
  // without inject", and from an async continuation the unhandled rejection
  // takes the whole host process down (the DSH crash of 2026-11-09).
  ctx.effect(() => attachRoutes(ctx, library, ask, options), 'reading: http routes')

  ctx.inject(['tools'], (scope) => {
    for (const definition of createTools(library)) {
      scope.effect(() => scope.tools.register(definition), `reading: tool ${definition.name}`)
    }
  })
}
