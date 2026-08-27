/**
 * `supabase2` — lightweight placeholder client for Supabase.
 *
 * The original code imports `supabase2` from `../../lib/supabase2` and uses the
 * PostgREST-style fluent API (`from().select().eq()`, `upsert`, `delete`, and
 * `functions.invoke`). No Supabase project URL/anon-key was shipped with the
 * uploaded files, so this module provides a graceful in-memory stub that:
 *
 *   - satisfies the exact same TypeScript surface used by the UI,
 *   - resolves every query/read with `{ data: null, error: null }` instead of
 *     crashing the app,
 *   - resolves Edge Function invocations with a success payload,
 *   - logs activity to the console for debugging.
 *
 * Swap this file for a real client when credentials are available:
 *
 *   import { createClient } from '@supabase/supabase-js'
 *   export const supabase2 = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)
 */

export interface SupabaseResult {
  data: any
  error: { message: string } | null
}

interface PostgrestOrderOptions {
  ascending?: boolean
}

interface UpsertOptions {
  onConflict?: string
}

interface FunctionInvokeOptions {
  body?: unknown
}

class PostgrestBuilder implements PromiseLike<SupabaseResult> {
  private readonly table: string
  private readonly action: string
  private readonly payload?: unknown

  constructor(table: string, action = 'query', payload?: unknown) {
    this.table = table
    this.action = action
    this.payload = payload
  }

  select(_columns?: string): this {
    return this
  }

  not(_column: string, _operator: string, _value: unknown): this {
    return this
  }

  order(_column: string, _options?: PostgrestOrderOptions): this {
    return this
  }

  limit(_count: number): this {
    return this
  }

  eq(_column: string, _value: unknown): this {
    return this
  }

  in(_column: string, _values: unknown[]): this {
    return this
  }

  delete(): this {
    return this
  }

  upsert(values: unknown, _options?: UpsertOptions): PostgrestBuilder {
    return new PostgrestBuilder(this.table, 'upsert', values)
  }

  then<TResult1 = SupabaseResult, TResult2 = never>(
    onfulfilled?: ((value: SupabaseResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  private async execute(): Promise<SupabaseResult> {
    console.info(
      `[supabase2] mock ${this.action} on "${this.table}"` +
        (this.payload !== undefined ? ` — payload attached` : ''),
    )
    return { data: null, error: null }
  }
}

const functions = {
  invoke(name: string, _options?: FunctionInvokeOptions): Promise<SupabaseResult> {
    console.info(`[supabase2] mock invoke function "${name}"`)
    return Promise.resolve({ data: { success: true }, error: null })
  },
}

export const supabase2 = {
  from(table: string): PostgrestBuilder {
    return new PostgrestBuilder(table)
  },
  functions,
}
